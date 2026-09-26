import http from 'node:http';
import https from 'node:https';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { summarize } from '../util/summarize.ts';

/**
 * Minimal client for an OpenAI-compatible `/v1/chat/completions` endpoint (vLLM, LM Studio,
 * llama.cpp, Ollama, OpenAI…) with function tools. Streams by default, so a model that
 * thinks for minutes never hits a total-time limit: only a silence of AGENT_LLM_TIMEOUT_MS fails.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Kept for transcripts and the dashboard; never sent back to the model. */
  reasoning?: string;
}

export interface FunctionTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface Completion {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: Usage | null;
  model: string;
  durationMs: number;
  /** Characters of the request's messages and tools, to relate characters to prompt tokens. */
  promptChars: number;
}

export interface CompleteOptions {
  messages: ChatMessage[];
  tools?: FunctionTool[];
  /** "auto" (default), "required", or force one function. */
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streamed reasoning and answer text, as it arrives. */
  onDelta?: (kind: 'reasoning' | 'content', text: string) => void;
  /** Extra fields for the log line of this request. */
  logContext?: Record<string, unknown>;
  /** Mask secrets in the logged tool-call arguments (e.g. text typed into a password field). */
  redactToolCall?: (name: string, args: unknown) => unknown;
}

export class LlmError extends Error {
  readonly status: number | null;
  /** Worth retrying: network errors, 5xx, 429. */
  readonly transient: boolean;
  /** The request did not fit the model's context window. */
  readonly contextOverflow: boolean;

  constructor(message: string, opts: { status?: number | null; transient?: boolean; contextOverflow?: boolean } = {}) {
    super(message);
    this.status = opts.status ?? null;
    this.transient = opts.transient ?? false;
    this.contextOverflow = opts.contextOverflow ?? false;
  }
}

export class LlmAbortedError extends LlmError {
  constructor() {
    super('the request was cancelled');
  }
}

const CONTEXT_OVERFLOW = /context length|maximum context|context window|too long|n_ctx|exceeds? the (?:max|limit)|max_model_len|prompt is too long/i;
const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

type AgentConfig = Config['agent'];

export class ChatClient {
  private readonly cfg: AgentConfig;
  private readonly log: Logger;
  private resolvedModel: Promise<string> | null = null;
  private requests = 0;
  /** false once the endpoint rejected tool_choice naming one function (LM Studio accepts only none/auto/required). */
  private namedToolChoice = true;

  constructor(cfg: AgentConfig, log: Logger) {
    if (!cfg.endpoint) throw new Error('No agent model endpoint configured (AGENT_LLM_URL)');
    this.cfg = cfg;
    this.log = log.child({ component: 'agent-llm' });
  }

  get endpoint(): string {
    return this.cfg.endpoint!;
  }

  /** The configured model id, or the first model the endpoint lists. */
  model(): Promise<string> {
    if (this.cfg.model) return Promise.resolve(this.cfg.model);
    if (!this.resolvedModel) {
      this.resolvedModel = this.listModels().then((ids) => {
        if (!ids.length) throw new LlmError(`The model endpoint lists no models (GET ${safeEndpoint(this.modelsUrl())}); set AGENT_LLM_MODEL`);
        this.log.info({ model: ids[0], available: ids }, 'using the first model the endpoint lists (set AGENT_LLM_MODEL to choose)');
        return ids[0];
      });
      this.resolvedModel.catch(() => (this.resolvedModel = null));
    }
    return this.resolvedModel;
  }

  private modelsUrl(): string {
    // rewrite the path only: a query (e.g. api-version) stays
    const u = new URL(this.endpoint);
    u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, '/models');
    return u.toString();
  }

  async listModels(timeoutMs = 15_000): Promise<string[]> {
    const res = await request(this.modelsUrl(), { method: 'GET', headers: this.headers(), idleTimeoutMs: timeoutMs });
    if (res.status >= 300 && res.status < 400) throw redirectError(res.status, res.location);
    if (res.status >= 400) throw new LlmError(describeHttpError(res.status, res.body), { status: res.status });
    try {
      const parsed = JSON.parse(res.body);
      return Array.isArray(parsed?.data) ? parsed.data.map((m: any) => String(m.id)).filter(Boolean) : [];
    } catch {
      throw new LlmError(`GET ${safeEndpoint(this.modelsUrl())} did not return JSON`);
    }
  }

  private headers(): Record<string, string> {
    return this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  /** One chat completion, retried on transient failures. */
  async complete(opts: CompleteOptions): Promise<Completion> {
    let attempt = 0;
    for (;;) {
      // an endpoint that cannot force one named function gets "required"; the agent loop then accepts only that function
      const named = typeof opts.toolChoice === 'object';
      const request = named && !this.namedToolChoice ? { ...opts, toolChoice: 'required' as const } : opts;
      try {
        return await this.completeOnce(request);
      } catch (err) {
        if (err instanceof LlmAbortedError || opts.signal?.aborted) throw new LlmAbortedError();
        if (named && this.namedToolChoice && err instanceof LlmError && err.status === 400 && /tool_choice/i.test(err.message)) {
          this.namedToolChoice = false;
          this.log.warn({ err: err.message }, 'the model endpoint does not accept a named tool_choice; using "required" instead');
          continue;
        }
        const e = err instanceof LlmError ? err : new LlmError((err as Error).message, { transient: true });
        if (!e.transient || attempt >= RETRY_DELAYS_MS.length) throw e;
        const delay = RETRY_DELAYS_MS[attempt++];
        this.log.warn({ err: e.message, status: e.status, attempt, retryInMs: delay }, 'model request failed; retrying');
        await sleep(delay, opts.signal);
      }
    }
  }

  private async completeOnce(opts: CompleteOptions): Promise<Completion> {
    const model = await this.model();
    const requestId = ++this.requests;
    const messages = opts.messages.map(toWire);
    const body: Record<string, unknown> = {
      model,
      messages,
      ...(this.cfg.temperature !== null ? { temperature: this.cfg.temperature } : {}),
      ...(this.cfg.topP !== null ? { top_p: this.cfg.topP } : {}),
      [this.cfg.maxTokensField]: opts.maxTokens ?? this.cfg.maxOutputTokens,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
      ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
      ...(this.cfg.thinking !== null ? { chat_template_kwargs: { enable_thinking: this.cfg.thinking } } : {}),
      ...this.cfg.extraBody,
    };
    if (this.cfg.streaming) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    const payload = JSON.stringify(body);
    const promptChars = JSON.stringify(messages).length + (opts.tools ? JSON.stringify(opts.tools).length : 0);
    const started = Date.now();
    this.log.debug(
      { requestId, model, messages: messages.length, tools: opts.tools?.length ?? 0, promptChars, stream: this.cfg.streaming, ...opts.logContext },
      'model request',
    );

    const out: Completion = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, model, durationMs: 0, promptChars };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const failure: { error: LlmError | null } = { error: null };

    const applyMessage = (message: any) => {
      if (typeof message?.content === 'string') out.content += message.content;
      const reasoning = message?.reasoning_content ?? message?.reasoning;
      if (typeof reasoning === 'string') out.reasoning += reasoning;
      (message?.tool_calls ?? []).forEach((tc: any, i: number) =>
        calls.set(i, {
          id: String(tc.id ?? ''),
          name: tc.function?.name ?? '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        }),
      );
    };

    const onEvent = (data: string) => {
      if (data === '[DONE]') return;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.error) {
        const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
        failure.error = new LlmError(`model error: ${msg}`, { contextOverflow: CONTEXT_OVERFLOW.test(msg), transient: !CONTEXT_OVERFLOW.test(msg) });
        return;
      }
      if (chunk.usage) out.usage = parseUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        out.reasoning += reasoning;
        opts.onDelta?.('reasoning', reasoning);
      }
      if (typeof delta.content === 'string' && delta.content) {
        out.content += delta.content;
        opts.onDelta?.('content', delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const index = typeof tc.index === 'number' ? tc.index : calls.size;
          const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) entry.id = String(tc.id);
          if (tc.function?.name) entry.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
          else if (tc.function?.arguments && typeof tc.function.arguments === 'object') entry.arguments = JSON.stringify(tc.function.arguments);
          calls.set(index, entry);
        }
      }
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
    };

    const res = await request(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: this.cfg.streaming ? 'text/event-stream' : 'application/json', ...this.headers() },
      body: payload,
      idleTimeoutMs: this.cfg.requestTimeoutMs,
      signal: opts.signal,
      onSseEvent: this.cfg.streaming ? onEvent : undefined,
    });
    if (res.status >= 300 && res.status < 400) throw redirectError(res.status, res.location);
    if (res.status >= 400) {
      const message = describeHttpError(res.status, res.body);
      this.log.warn({ requestId, status: res.status, error: message }, 'model request failed');
      throw new LlmError(message, {
        status: res.status,
        transient: res.status >= 500 || res.status === 429 || res.status === 408,
        contextOverflow: CONTEXT_OVERFLOW.test(res.body),
      });
    }
    if (!res.streamed) {
      // non-streaming request, or a server that answered a streaming request with plain JSON
      try {
        const parsed = JSON.parse(res.body);
        if (parsed.error) throw new LlmError(`model error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
        applyMessage(parsed.choices?.[0]?.message);
        out.finishReason = parsed.choices?.[0]?.finish_reason ?? null;
        out.usage = parsed.usage ? parseUsage(parsed.usage) : null;
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw new LlmError(`the model endpoint returned invalid JSON: ${(err as Error).message}`, { transient: true });
      }
    }
    if (failure.error) throw failure.error;
    out.toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${requestId}_${i}` }))
      .filter((c) => c.name);
    if (!out.reasoning && out.content.includes('</think>')) {
      const split = splitThinking(out.content);
      out.reasoning = split.reasoning;
      out.content = split.content;
    }
    out.durationMs = Date.now() - started;
    this.log.info(
      {
        requestId,
        durationMs: out.durationMs,
        finishReason: out.finishReason,
        usage: out.usage,
        toolCalls: out.toolCalls.map((c) => ({
          name: c.name,
          // the hook gets the raw text and parses it the way the agent loop does
          arguments: summarize(opts.redactToolCall ? opts.redactToolCall(c.name, c.arguments) : safeJson(c.arguments), { maxString: 300 }),
        })),
        content: out.content ? out.content.slice(0, 500) : undefined,
        reasoningChars: out.reasoning.length,
        ...opts.logContext,
      },
      `model response (${out.durationMs} ms, ${out.toolCalls.length} tool call${out.toolCalls.length === 1 ? '' : 's'})`,
    );
    return out;
  }
}

/** The endpoint URL without credentials (user info, query string), for logs and messages. */
export function safeEndpoint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '(invalid URL)';
  }
}

function redirectError(status: number, location: string | null): LlmError {
  return new LlmError(
    `the model endpoint redirected (HTTP ${status})${location ? ` to ${safeEndpoint(location)}` : ''}; set AGENT_LLM_URL to the final URL`,
    { status },
  );
}

function toWire(m: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls?.length) wire.tool_calls = m.tool_calls;
  if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
  return wire;
}

function parseUsage(u: any): Usage {
  return {
    promptTokens: Number(u.prompt_tokens ?? 0),
    completionTokens: Number(u.completion_tokens ?? 0),
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeHttpError(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? parsed.detail ?? body);
    if (typeof message !== 'string') message = JSON.stringify(message);
  } catch {
    // keep the raw text
  }
  message = message.slice(0, 1_000);
  if (status === 401 || status === 403) return `the model endpoint rejected the API key (HTTP ${status}): ${message}. Check AGENT_LLM_API_KEY.`;
  if (status === 404) return `HTTP 404 from the model endpoint: ${message}. Check AGENT_LLM_URL and AGENT_LLM_MODEL.`;
  return `HTTP ${status} from the model endpoint: ${message}`;
}

/** Separate `<think>` blocks for servers that do not split reasoning out of the content. */
export function splitThinking(content: string): { reasoning: string; content: string } {
  let reasoning = '';
  let rest = content.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
    reasoning += inner;
    return '';
  });
  if (!reasoning && rest.includes('</think>')) {
    const close = rest.indexOf('</think>');
    reasoning = rest.slice(0, close);
    rest = rest.slice(close + 8);
  }
  return { reasoning: reasoning.trim(), content: rest.trim() };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new LlmAbortedError());
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestOptions {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  /** Parse a text/event-stream response line by line instead of buffering it. */
  onSseEvent?: (data: string) => void;
}

/**
 * HTTP request over node:http (no fetch header/body deadlines: prompt processing of a long
 * transcript can take minutes on a large local model). Only a silence longer than idleTimeoutMs fails.
 */
function request(target: string, opts: RequestOptions): Promise<{ status: number; body: string; streamed: boolean; location: string | null }> {
  const url = new URL(target);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: { status: number; body: string; streamed: boolean; location: string | null }) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => req.destroy(new LlmAbortedError());
    const headers: Record<string, string | number> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = lib.request(url, { method: opts.method, headers }, (res) => {
      res.setEncoding('utf8');
      const status = res.statusCode ?? 0;
      const sse = Boolean(opts.onSseEvent) && status < 400 && /text\/event-stream/i.test(String(res.headers['content-type'] ?? ''));
      let buffer = '';
      // a malformed event must fail this request, not escape into the process
      const deliver = (data: string): boolean => {
        try {
          opts.onSseEvent!(data);
          return true;
        } catch (err) {
          req.destroy(new LlmError(`invalid event from the model endpoint: ${(err as Error).message}`, { transient: true }));
          return false;
        }
      };
      res.on('data', (d: string) => {
        buffer += d;
        if (!sse) return;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.startsWith('data:') && !deliver(line.slice(5).trim())) return;
        }
      });
      res.on('end', () => {
        if (sse && buffer.startsWith('data:') && !deliver(buffer.slice(5).trim())) return;
        finish(null, { status, body: sse ? '' : buffer, streamed: sse, location: typeof res.headers.location === 'string' ? res.headers.location : null });
      });
      res.on('error', (err) => finish(err instanceof LlmError ? err : new LlmError(`the model response was interrupted: ${err.message}`, { transient: true })));
    });
    req.setTimeout(opts.idleTimeoutMs, () =>
      req.destroy(new LlmError(`the model endpoint sent nothing for ${Math.round(opts.idleTimeoutMs / 1000)} s (AGENT_LLM_TIMEOUT_MS)`, { transient: true })),
    );
    req.on('error', (err: any) => {
      if (err instanceof LlmError) return finish(err);
      const code = err?.code ?? err?.message;
      finish(new LlmError(`cannot reach the model endpoint ${safeEndpoint(url.href)} (${code})`, { transient: true }));
    });
    if (opts.signal) {
      if (opts.signal.aborted) return void req.destroy(new LlmAbortedError());
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(opts.body);
  });
}
