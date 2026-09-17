/**
 * Command-line browser agent: a local LLM served by LM Studio drives the
 * Stealth Browser MCP server.
 *
 *   node scripts/lmstudio-agent.ts "Open https://example.com and tell me the heading"
 *
 * This process is the MCP client (Streamable HTTP) and talks to LM Studio's
 * OpenAI-compatible /v1/chat/completions endpoint with function tools, so it
 * needs no LM Studio mcp.json entry, API token or plugin settings. Every tool
 * call still goes through the server, so it shows up in the server logs and
 * on the live dashboard.
 *
 * `runAgent()` is exported for scripts/lmstudio-e2e.ts.
 */
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { parseArgs, styleText } from 'node:util';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';

export const DEFAULT_MCP_URL = 'http://127.0.0.1:8931/mcp';
export const DEFAULT_LMSTUDIO_URL = 'http://127.0.0.1:1234';

export type ReasoningMode = 'none' | 'low' | 'medium' | 'high' | 'on';
export const REASONING_MODES: readonly ReasoningMode[] = ['none', 'low', 'medium', 'high', 'on'];

export interface AgentOptions {
  task: string;
  /** Streamable HTTP endpoint of the Stealth Browser MCP server. */
  mcpUrl?: string;
  /** Bearer token for the MCP server (its AUTH_TOKEN). */
  authToken?: string;
  lmstudioUrl?: string;
  /** LM Studio API token, when "Require Authentication" is enabled. */
  lmApiToken?: string;
  /** Model id; default: the first loaded LLM trained for tool use. */
  model?: string;
  maxSteps?: number;
  /** Reasoning effort; `on` leaves the model default. */
  reasoning?: ReasoningMode;
  /** Only offer these tools to the model. */
  tools?: string[];
  /** Only offer tools from these groups (core, content, forms, tabs, state, debug, capture). */
  toolsets?: string[];
  /** Forward screenshots to the model as images (default: when the model supports vision). */
  vision?: boolean;
  temperature?: number;
  /** Output token limit per model response, reasoning included. */
  maxTokens?: number;
  /** Tool results longer than this are truncated before they reach the model. */
  maxResultChars?: number;
  toolTimeoutMs?: number;
  /** Extra instructions appended to the system prompt. */
  instructions?: string;
  /** MCP client name (shown in server logs and on the dashboard). */
  clientName?: string;
  /** Print only the final answer. */
  quiet?: boolean;
  /** Where transcript text goes (default: stdout). */
  write?: (text: string) => void;
  color?: boolean;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  step: number;
  id: string;
  name: string;
  args: unknown;
  isError: boolean;
  /** False when the call never reached the server (unknown tool, invalid JSON arguments). */
  executed: boolean;
  durationMs: number;
  /** Text given to the model (after truncation). */
  result: string;
  images: number;
}

export interface StepRecord {
  step: number;
  llmMs: number;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoning: string | null;
  content: string | null;
  toolCalls: string[];
}

export interface AgentResult {
  ok: boolean;
  stopReason: 'final_answer' | 'max_steps' | 'error' | 'aborted';
  finalAnswer: string | null;
  error: string | null;
  model: string;
  mcpUrl: string;
  steps: number;
  toolCalls: ToolCallRecord[];
  stepsDetail: StepRecord[];
  usage: { promptTokens: number; completionTokens: number; reasoningTokens: number };
  tools: string[];
  startedAt: string;
  durationMs: number;
  messages: ChatMessage[];
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface Completion {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
  reasoningStreamed: boolean;
}

export class AgentError extends Error {}

// ---------------------------------------------------------------------------
// LM Studio

export interface ModelInfo {
  id: string;
  /** LM Studio knows this model (false: an id passed explicitly that is not in the model list). */
  listed: boolean;
  loaded: boolean;
  vision: boolean;
  toolUse: boolean;
  reasoning: string[] | null;
  contextLength: number | null;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function lmStudioUnreachable(base: string, err: unknown): AgentError {
  const code = (err as any)?.cause?.code ?? (err as any)?.code ?? (err as Error)?.message;
  return new AgentError(
    `Cannot reach LM Studio at ${base} (${code}). Start the local server (LM Studio > Developer > Start Server, or \`~/.lmstudio/bin/lms server start\`) ` +
      'and use 127.0.0.1 rather than localhost. Override with LMSTUDIO_URL.',
  );
}

async function getJson(url: string, token: string | undefined): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: authHeaders(token), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** List LLMs known to LM Studio with their capabilities (native /api/v1/models). */
export async function listModels(lmstudioUrl: string, token?: string): Promise<ModelInfo[] | null> {
  const base = lmstudioUrl.replace(/\/+$/, '');
  let res;
  try {
    res = await getJson(`${base}/api/v1/models`, token);
  } catch (err) {
    throw lmStudioUnreachable(base, err);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AgentError(`LM Studio rejected the request (HTTP ${res.status}). "Require Authentication" is on: set LM_API_TOKEN to an API token.`);
  }
  if (res.status !== 200 || !Array.isArray(res.body?.models)) return null;
  return res.body.models
    .filter((m: any) => m.type === 'llm')
    .map((m: any) => ({
      id: m.loaded_instances?.[0]?.id ?? m.key,
      listed: true,
      loaded: (m.loaded_instances?.length ?? 0) > 0,
      vision: Boolean(m.capabilities?.vision),
      toolUse: Boolean(m.capabilities?.trained_for_tool_use),
      reasoning: Array.isArray(m.capabilities?.reasoning?.allowed_options) ? m.capabilities.reasoning.allowed_options : null,
      contextLength: m.loaded_instances?.[0]?.config?.context_length ?? null,
      key: m.key,
    }));
}

export async function resolveModel(lmstudioUrl: string, token: string | undefined, requested?: string): Promise<ModelInfo> {
  const models = await listModels(lmstudioUrl, token);
  if (requested) {
    const found = models?.find((m) => m.id === requested || (m as any).key === requested);
    if (found) return { ...found, id: requested };
    return { id: requested, listed: false, loaded: false, vision: false, toolUse: true, reasoning: null, contextLength: null };
  }
  if (!models) {
    throw new AgentError('Could not list models from LM Studio (GET /api/v1/models needs LM Studio 0.4 or newer). Pass --model <id> or set LMSTUDIO_MODEL.');
  }
  const loaded = models.filter((m) => m.loaded && m.toolUse);
  if (loaded.length > 0) return loaded[0];
  const installed = models.filter((m) => m.toolUse).map((m) => (m as any).key as string);
  throw new AgentError(
    installed.length
      ? `No loaded LM Studio model is trained for tool use. Load one first, e.g. \`~/.lmstudio/bin/lms load ${installed[0]} --context-length 32768\`, or pass --model ${installed[0]} (LM Studio loads it on demand). Tool-capable models installed: ${installed.join(', ')}.`
      : 'No tool-capable LLM is installed in LM Studio. Download one trained for tool use (for example a Qwen3 model) and load it with a context length of at least 32k, or pass --model <id>.',
  );
}

function describeLmStudioError(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body);
  } catch {
    // keep raw text
  }
  message = message.slice(0, 1000);
  if (status === 401 || status === 403) return `LM Studio rejected the request (HTTP ${status}): ${message}. Set LM_API_TOKEN.`;
  if (/context|n_ctx|too long|exceed/i.test(message)) {
    return `LM Studio: ${message}. The conversation no longer fits the model context: reload the model with a larger context length (32k or more) or lower --max-result-chars.`;
  }
  if (status === 404 || /model/i.test(message) && /not found|no model/i.test(message)) {
    return `LM Studio: ${message}. Check the model id with \`~/.lmstudio/bin/lms ls\` or omit --model to use the loaded one.`;
  }
  return `LM Studio HTTP ${status}: ${message}`;
}

class HttpStatusError extends AgentError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Streaming chat completion over node:http (no fetch header/body timeouts:
 * prompt processing of a long browser transcript can take minutes on a large
 * local model).
 */
function streamChatCompletion(
  lmstudioUrl: string,
  token: string | undefined,
  body: Record<string, unknown>,
  onReasoning: (delta: string) => void,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<Completion> {
  const url = new URL(`${lmstudioUrl.replace(/\/+$/, '')}/v1/chat/completions`);
  const payload = JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } });
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise<Completion>((resolve, reject) => {
    const out: Completion = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null, reasoningStreamed: false };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) return reject(err);
      out.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
      resolve(out);
    };
    const onAbort = () => {
      req.destroy(new AgentError('aborted'));
    };
    const handleEvent = (data: string) => {
      if (data === '[DONE]') return;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (chunk.error) {
        const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? JSON.stringify(chunk.error));
        req.destroy(new HttpStatusError(500, describeLmStudioError(500, JSON.stringify({ error: msg }))));
        return;
      }
      if (chunk.usage) out.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? choice.message ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        out.reasoning += reasoning;
        out.reasoningStreamed = true;
        onReasoning(reasoning);
      }
      if (typeof delta.content === 'string') out.content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
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

    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(payload), ...authHeaders(token) },
      },
      (res) => {
        res.setEncoding('utf8');
        if ((res.statusCode ?? 0) >= 400) {
          let text = '';
          res.on('data', (d: string) => (text += d));
          res.on('end', () => finish(new HttpStatusError(res.statusCode ?? 0, describeLmStudioError(res.statusCode ?? 0, text))));
          return;
        }
        const isJson = /application\/json/i.test(String(res.headers['content-type'] ?? ''));
        let buffer = '';
        res.on('data', (d: string) => {
          buffer += d;
          if (isJson) return;
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
          }
        });
        res.on('end', () => {
          if (isJson) {
            try {
              const parsed = JSON.parse(buffer);
              const message = parsed.choices?.[0]?.message ?? {};
              out.content = message.content ?? '';
              out.reasoning = message.reasoning_content ?? '';
              out.finishReason = parsed.choices?.[0]?.finish_reason ?? null;
              out.usage = parsed.usage ?? null;
              (message.tool_calls ?? []).forEach((tc: any, i: number) =>
                calls.set(i, { id: String(tc.id ?? ''), name: tc.function?.name ?? '', arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) }),
              );
            } catch (err) {
              return finish(new AgentError(`LM Studio returned invalid JSON: ${(err as Error).message}`));
            }
          } else if (buffer.startsWith('data:')) {
            handleEvent(buffer.slice(5).trim());
          }
          finish();
        });
        res.on('error', (err) => finish(err));
      },
    );
    req.setTimeout(idleTimeoutMs, () => req.destroy(new AgentError(`LM Studio sent nothing for ${Math.round(idleTimeoutMs / 1000)} s`)));
    req.on('error', (err: any) => {
      if (err instanceof AgentError) return finish(err);
      finish(Object.assign(lmStudioUnreachable(url.origin, err), { transient: true }));
    });
    if (signal) {
      if (signal.aborted) return finish(new AgentError('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// MCP

export async function connectMcp(mcpUrl: string, authToken: string | undefined, clientName: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: authHeaders(authToken) } });
  try {
    await client.connect(transport);
  } catch (err) {
    const status = (err as any)?.data?.status ?? (err as any)?.status;
    const hint =
      status === 401
        ? 'the server requires a token: set AUTH_TOKEN'
        : status === 403
          ? 'the Host header was rejected: use 127.0.0.1 or add the host to ALLOWED_HOSTS on the server'
          : 'is the server running? Start it with `docker compose up -d` or `npm run dev`, or set MCP_URL';
    throw new AgentError(`Cannot connect to the MCP server at ${mcpUrl}: ${(err as Error).message} (${hint})`);
  }
  return { client, transport };
}

/** MCP tool -> OpenAI function tool. */
export function toOpenAITool(tool: Tool): OpenAITool {
  const parameters: Record<string, any> = structuredClone((tool.inputSchema ?? {}) as Record<string, unknown>);
  delete parameters.$schema;
  parameters.type = 'object';
  if (!parameters.properties || typeof parameters.properties !== 'object') parameters.properties = {};
  return { type: 'function', function: { name: tool.name, description: tool.description ?? tool.title ?? tool.name, parameters } };
}

async function groupMap(): Promise<Map<string, string>> {
  try {
    const mod = await import('../src/tools/index.ts');
    return new Map((mod.ALL_TOOLS as Array<{ name: string; group: string }>).map((t) => [t.name, t.group]));
  } catch (err) {
    throw new AgentError(
      `--toolsets needs the tool registry from this repository (${(err as Error).message}). Use --tools name1,name2 instead, or set TOOLSETS on the server.`,
    );
  }
}

export async function selectTools(tools: Tool[], names?: string[], toolsets?: string[]): Promise<Tool[]> {
  let selected = tools;
  const sets = toolsets?.map((s) => s.toLowerCase());
  if (sets?.length && !sets.includes('all')) {
    const groups = await groupMap();
    const knownGroups = new Set(groups.values());
    const unknown = sets.filter((s) => !knownGroups.has(s) && !tools.some((t) => t.name === s));
    if (unknown.length) {
      throw new AgentError(`Unknown toolset(s): ${unknown.join(', ')}. Groups: ${[...knownGroups].join(', ')} (or all).`);
    }
    const wanted = new Set(sets);
    selected = selected.filter((t) => wanted.has(groups.get(t.name) ?? '') || wanted.has(t.name));
  }
  if (names?.length) {
    const unknown = names.filter((n) => !tools.some((t) => t.name === n));
    if (unknown.length) throw new AgentError(`Unknown tool(s): ${unknown.join(', ')}. The server offers: ${tools.map((t) => t.name).join(', ')}`);
    const extra = tools.filter((t) => names.includes(t.name) && !selected.includes(t));
    selected = toolsets?.length ? [...selected, ...extra] : tools.filter((t) => names.includes(t.name));
  }
  if (selected.length === 0) throw new AgentError('No tools selected: check --tools / --toolsets against the tools the server offers.');
  return selected;
}

// ---------------------------------------------------------------------------
// Conversation helpers

export function buildSystemPrompt(serverInstructions: string | undefined, vision: boolean, extra?: string): string {
  const parts = [
    `You are a browser automation agent. You control a real web browser (headless, JavaScript enabled) through the provided tools and complete the user's task on your own. The user cannot answer questions while you work.

How to work:
- Open pages with browser_navigate, then read them with browser_snapshot before anything else; do not guess CSS selectors for a page you have not read. Snapshots list interactive elements with refs such as "e12"; pass a ref to the interaction tools. Refs change when the page changes: take a new snapshot before reusing them.
- Do one step at a time and check each tool result before the next call. If a tool returns an error, read the message and change your approach instead of repeating the same call.
- Only report facts that appear in tool results, and copy requested text exactly as the page shows it.
- When the task is done, stop calling tools and reply with a short final answer that contains the requested values.`,
    vision
      ? 'Screenshots from browser_screenshot are attached as images right after the tool result.'
      : 'You cannot see images: rely on browser_snapshot and other text tools to understand pages.',
  ];
  if (serverInstructions?.trim()) parts.push(`Notes from the browser server:\n${serverInstructions.trim()}`);
  if (extra?.trim()) parts.push(extra.trim());
  return parts.join('\n\n');
}

/** Parse tool-call arguments, tolerating code fences and trailing junk around one JSON object. */
export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '' || text === 'null') return { ok: true, value: {} };
  const attempt = (s: string) => {
    const v = JSON.parse(s);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('arguments must be a JSON object');
    return v as Record<string, unknown>;
  };
  try {
    return { ok: true, value: attempt(text) };
  } catch (err) {
    const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: attempt(unfenced.slice(start, end + 1)) };
      } catch {
        // fall through
      }
    }
    return { ok: false, error: (err as Error).message };
  }
}

/** Separate `<think>` blocks when LM Studio is not configured to split reasoning into reasoning_content. */
export function splitThinking(content: string): { reasoning: string; content: string } {
  let reasoning = '';
  let rest = content.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
    reasoning += inner;
    return '';
  });
  const open = rest.indexOf('<think>');
  if (open >= 0) {
    reasoning += rest.slice(open + 7);
    rest = rest.slice(0, open);
  } else if (!reasoning && rest.includes('</think>')) {
    const close = rest.indexOf('</think>');
    reasoning = rest.slice(0, close);
    rest = rest.slice(close + 8);
  }
  return { reasoning: reasoning.trim(), content: rest.trim() };
}

const TEXT_TOOL_CALL = /<tool_call>|<function[=\s]|"name"\s*:\s*"browser_[a-z_]+"|\bbrowser_[a-z_]+\s*\(\s*\{/;

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} characters. Use more specific tools or options to read the rest.]`;
}

export function formatToolResult(result: CallToolResult, maxChars: number, vision: boolean): { text: string; images: Array<{ mimeType: string; data: string }> } {
  const texts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const item of (result.content ?? []) as any[]) {
    if (item.type === 'text') texts.push(item.text);
    else if (item.type === 'image') {
      if (vision) {
        images.push({ mimeType: item.mimeType, data: item.data });
        texts.push(`[image ${item.mimeType} attached in the next message]`);
      } else {
        texts.push('[image returned; not shown because vision is off]');
      }
    } else if (item.type === 'resource') {
      texts.push(item.resource?.text ?? `[resource ${item.resource?.uri ?? ''}]`);
    } else if (item.type === 'resource_link') {
      texts.push(`[resource link ${item.name ?? ''} ${item.uri ?? ''}]`.trim());
    } else {
      texts.push(`[${item.type} content omitted]`);
    }
  }
  if (result.structuredContent && texts.length === 0) texts.push(JSON.stringify(result.structuredContent));
  let text = texts.join('\n').trim() || (result.isError ? 'Error: the tool failed without a message' : '(no output)');
  if (result.isError && !/^error\b/i.test(text)) text = `Error: ${text}`;
  return { text: truncateText(text, maxChars), images };
}

const OLD_RESULT_CHARS = 1_500;
const MIN_RESULT_CHARS = 300;
const KEEP_FULL_RESULTS = 6;
/** Rough prompt cost of one attached screenshot, in characters of text. */
const IMAGE_CHARS = 4_000;
/** Conservative characters per token for browser text and JSON (measured ~3.7 for the tool definitions). */
export const CHARS_PER_TOKEN = 3.2;

function contentChars(m: ChatMessage): number {
  const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
  if (typeof m.content === 'string') return m.content.length + toolCalls;
  if (!Array.isArray(m.content)) return toolCalls;
  return toolCalls + m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : IMAGE_CHARS), 0);
}

/**
 * Keep the context small: shorten old tool results and drop images from earlier
 * turns. With `maxChars` (derived from the loaded context length), older results
 * are shortened further until the conversation fits; the newest result stays whole.
 */
export function compactHistory(messages: ChatMessage[], maxChars = Number.POSITIVE_INFINITY): void {
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const shorten = (i: number, limit: number, note: string) => {
    const m = messages[i];
    if (typeof m.content === 'string' && m.content.length > limit + 100) m.content = `${m.content.slice(0, limit)}\n...[${note}]`;
  };
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL_RESULTS))) shorten(i, OLD_RESULT_CHARS, 'older result shortened to save context');
  const imageIdx = messages.flatMap((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url') ? [i] : []));
  for (const i of imageIdx.slice(0, -1)) {
    const m = messages[i];
    m.content = (m.content as ChatContentPart[]).map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: '[image from an earlier step removed to save context]' } : p));
  }
  if (!Number.isFinite(maxChars)) return;
  const total = () => messages.reduce((n, m) => n + contentChars(m), 0);
  for (const limit of [OLD_RESULT_CHARS, MIN_RESULT_CHARS]) {
    for (const i of toolIdx.slice(0, -1)) {
      if (total() <= maxChars) return;
      shorten(i, limit, 'older result shortened to fit the model context');
    }
  }
}

function redactImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: `[image, ${p.image_url.url.length} base64 chars]` } : p)) }
      : m,
  );
}

// ---------------------------------------------------------------------------
// Output

class Printer {
  private readonly write: (text: string) => void;
  private readonly quiet: boolean;
  private readonly color: boolean;
  private readonly customWrite: boolean;
  private midLine = false;

  constructor(opts: AgentOptions) {
    this.customWrite = Boolean(opts.write);
    this.write = opts.write ?? ((t) => process.stdout.write(t));
    this.quiet = Boolean(opts.quiet);
    this.color = opts.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  }

  style(format: Parameters<typeof styleText>[0], text: string): string {
    return this.color ? styleText(format, text, { validateStream: false }) : text;
  }

  line(text = ''): void {
    if (this.quiet) return;
    this.endStream();
    this.write(`${text}\n`);
  }

  stream(text: string): void {
    if (this.quiet || !text) return;
    this.write(this.style('dim', text));
    this.midLine = !text.endsWith('\n');
  }

  endStream(): void {
    if (this.midLine) {
      this.write('\n');
      this.midLine = false;
    }
  }

  always(text: string): void {
    this.endStream();
    this.write(`${text}\n`);
  }

  error(text: string): void {
    this.endStream();
    if (this.customWrite) this.write(`${text}\n`);
    else process.stderr.write(`${text}\n`);
  }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function preview(text: string, maxLines = 3, width = 160): string[] {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const shown = lines.slice(0, maxLines).map((l) => (l.length > width ? `${l.slice(0, width - 3)}...` : l));
  if (lines.length > maxLines) shown.push(`... (${lines.length - maxLines} more lines)`);
  return shown;
}

// ---------------------------------------------------------------------------
// Agent loop

function isTransient(err: unknown): boolean {
  if ((err as any)?.transient) return true;
  return err instanceof HttpStatusError && (err.status >= 500 || err.status === 429) && !/context|too long|exceed/i.test(err.message);
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const started = Date.now();
  const out = new Printer(options);
  const mcpUrl = options.mcpUrl ?? DEFAULT_MCP_URL;
  const lmstudioUrl = (options.lmstudioUrl ?? DEFAULT_LMSTUDIO_URL).replace(/\/+$/, '');
  const maxSteps = options.maxSteps ?? 25;
  const maxResultChars = options.maxResultChars ?? 12_000;
  const toolTimeoutMs = options.toolTimeoutMs ?? 180_000;
  const clientName = options.clientName ?? 'lmstudio-agent';
  const messages: ChatMessage[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const stepsDetail: StepRecord[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  let toolNames: string[] = [];
  let modelId = options.model ?? '(unresolved)';

  const result = (stopReason: AgentResult['stopReason'], finalAnswer: string | null, error: string | null): AgentResult => ({
    ok: stopReason === 'final_answer',
    stopReason,
    finalAnswer,
    error,
    model: modelId,
    mcpUrl,
    steps: stepsDetail.length,
    toolCalls,
    stepsDetail,
    usage,
    tools: toolNames,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    messages: redactImages(messages),
  });

  let mcp: { client: Client; transport: StreamableHTTPClientTransport } | null = null;
  try {
    const model = await resolveModel(lmstudioUrl, options.lmApiToken, options.model);
    modelId = model.id;
    const vision = options.vision ?? model.vision;
    const reasoning = options.reasoning ?? 'low';
    let reasoningEffort: string | undefined;
    if (reasoning !== 'on' && (model.reasoning || !model.listed)) reasoningEffort = reasoning;

    mcp = await connectMcp(mcpUrl, options.authToken, clientName);
    const { tools: allTools } = await mcp.client.listTools();
    const tools = await selectTools(allTools, options.tools, options.toolsets);
    toolNames = tools.map((t) => t.name);
    const openAITools = tools.map(toOpenAITool);
    const known = new Set(toolNames);

    messages.push({ role: 'system', content: buildSystemPrompt(mcp.client.getInstructions(), vision, options.instructions) });
    messages.push({ role: 'user', content: options.task });

    out.line(
      out.style('bold', 'Stealth Browser agent') +
        out.style(
          'dim',
          ` | model ${model.id}${!model.listed ? ' (not in LM Studio\'s model list; check the id with `lms ls`)' : model.loaded ? '' : ' (not loaded yet: LM Studio loads it on the first request)'} | reasoning ${reasoning} | vision ${vision ? 'on' : 'off'} | ${tools.length} tools | ${mcpUrl}`,
        ),
    );
    // Character budget for the conversation, so old results get shortened before the prompt overflows the loaded context.
    const maxTokens = options.maxTokens ?? 8192;
    const toolChars = JSON.stringify(openAITools).length;
    const historyBudget = model.contextLength
      ? Math.floor((model.contextLength - maxTokens) * CHARS_PER_TOKEN) - toolChars
      : Number.POSITIVE_INFINITY;
    if (model.contextLength && (model.contextLength < 16_000 || historyBudget < 20_000)) {
      out.line(
        out.style(
          'yellow',
          `Warning: the model is loaded with a ${model.contextLength}-token context, which leaves little room next to ${tools.length} tool definitions and --max-tokens ${maxTokens}. ` +
            'Reload it with a context of 32k or more, or use --toolsets core.',
        ),
      );
    }
    out.line(`${out.style('bold', 'Task:')} ${options.task}`);

    let nudges = 0;
    let lastCompletion: Completion | null = null;

    const callModel = async (step: number, withTools: boolean): Promise<Completion> => {
      compactHistory(messages, Math.max(8_000, historyBudget));
      const body: Record<string, unknown> = {
        model: model.id,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: maxTokens,
      };
      if (withTools) {
        body.tools = openAITools;
        body.tool_choice = 'auto';
      }
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;
      out.line('');
      out.line(out.style(['bold', 'cyan'], `[step ${step}]`) + out.style('dim', ` +${seconds(Date.now() - started)} waiting for the model...`));
      for (let attempt = 1; ; attempt++) {
        const t0 = Date.now();
        let printedThinking = false;
        try {
          const completion = await streamChatCompletion(
            lmstudioUrl,
            options.lmApiToken,
            body,
            (delta) => {
              if (!printedThinking) {
                out.stream('  thinking: ');
                printedThinking = true;
              }
              out.stream(delta.replace(/\n+/g, ' '));
            },
            options.signal,
            600_000,
          );
          out.endStream();
          const split = splitThinking(completion.content);
          if (split.reasoning) {
            completion.reasoning = [completion.reasoning, split.reasoning].filter(Boolean).join('\n');
            if (!printedThinking) out.line(out.style('dim', `  thinking: ${split.reasoning.replace(/\n+/g, ' ')}`));
          }
          completion.content = split.content;
          const llmMs = Date.now() - t0;
          const u = completion.usage;
          usage.promptTokens += u?.prompt_tokens ?? 0;
          usage.completionTokens += u?.completion_tokens ?? 0;
          usage.reasoningTokens += u?.completion_tokens_details?.reasoning_tokens ?? 0;
          stepsDetail.push({
            step,
            llmMs,
            finishReason: completion.finishReason,
            promptTokens: u?.prompt_tokens ?? null,
            completionTokens: u?.completion_tokens ?? null,
            reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
            reasoning: completion.reasoning || null,
            content: completion.content || null,
            toolCalls: completion.toolCalls.map((c) => c.name),
          });
          out.line(out.style('dim', `  model ${seconds(llmMs)}${u ? ` | ${u.prompt_tokens ?? '?'} prompt + ${u.completion_tokens ?? '?'} output tokens` : ''}`));
          return completion;
        } catch (err) {
          out.endStream();
          if (options.signal?.aborted) throw err;
          if (attempt < 3 && isTransient(err)) {
            out.line(out.style('yellow', `  model request failed (${(err as Error).message}); retrying...`));
            await new Promise((r) => setTimeout(r, 2_000 * attempt));
            continue;
          }
          throw err;
        }
      }
    };

    const callTool = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return (await mcp!.client.callTool({ name, arguments: args }, { timeout: toolTimeoutMs, signal: options.signal })) as CallToolResult;
        } catch (err) {
          const status = (err as any)?.data?.status ?? (err as any)?.status;
          const network = !status && /fetch failed|ECONNREFUSED|ECONNRESET|socket/i.test(`${(err as Error).message} ${(err as any)?.cause?.code ?? ''}`);
          if (attempt === 1 && (status === 404 || network)) {
            out.line(out.style('yellow', `  MCP connection lost (${(err as Error).message}); reconnecting...`));
            await mcp!.client.close().catch(() => undefined);
            mcp = await connectMcp(mcpUrl, options.authToken, clientName);
            continue;
          }
          if (network) throw new AgentError(`Lost the connection to the MCP server at ${mcpUrl}: ${(err as Error).message}`);
          return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
        }
      }
    };

    for (let step = 1; step <= maxSteps; step++) {
      const completion = await callModel(step, true);
      lastCompletion = completion;

      if (completion.toolCalls.length === 0) {
        const content = completion.content.trim();
        const textToolCall = Boolean(content) && TEXT_TOOL_CALL.test(content);
        const problem = !content
          ? completion.finishReason === 'length'
            ? 'Your response hit the output token limit before you called a tool or answered. Think less and act: call the next tool, or give the final answer.'
            : 'You neither called a tool nor gave an answer. Continue the task with a tool call, or give your final answer.'
          : textToolCall
            ? 'Your last message described a tool call as text, so nothing was executed. Call tools through the function-calling interface (one JSON arguments object per call), or give the final answer as plain text.'
            : null;
        if (problem && nudges < 2) {
          nudges++;
          out.line(out.style('yellow', `  ${content ? 'tool call written as text' : 'empty response'}; asking the model to continue`));
          if (content) messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: problem });
          continue;
        }
        if (!content) return finalize(result('error', null, 'The model returned an empty response.'));
        if (textToolCall) {
          messages.push({ role: 'assistant', content });
          return finalize(
            result(
              'error',
              null,
              `The model keeps writing tool calls as text instead of calling tools (last reply: ${content.slice(0, 200)}). Use a model trained for tool use, or try --reasoning none / --toolsets core.`,
            ),
          );
        }
        out.line('');
        out.line(out.style(['bold', 'green'], `Final answer`) + out.style('dim', ` (${stepsDetail.length} steps, ${toolCalls.length} tool calls, ${seconds(Date.now() - started)})`));
        if (options.quiet) out.always(content);
        else out.line(content);
        messages.push({ role: 'assistant', content });
        return finalize(result('final_answer', content, null));
      }

      if (completion.content.trim()) out.line(`  ${completion.content.trim().replace(/\n+/g, '\n  ')}`);
      const assistantCalls = completion.toolCalls.map((c, i) => ({
        id: c.id || `call_${step}_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      }));
      messages.push({ role: 'assistant', content: completion.content || '', tool_calls: assistantCalls });

      const pendingImages: Array<{ tool: string; mimeType: string; data: string }> = [];
      for (const call of assistantCalls) {
        const t0 = Date.now();
        const parsed = parseToolArguments(call.function.arguments);
        let text: string;
        let isError = true;
        let images: Array<{ mimeType: string; data: string }> = [];
        let args: unknown = call.function.arguments;
        let executed = false;
        out.line(`  ${out.style('magenta', '->')} ${out.style('bold', call.function.name)} ${out.style('dim', parsed.ok ? JSON.stringify(parsed.value) : call.function.arguments)}`);
        if (!known.has(call.function.name)) {
          text = `Error: unknown tool "${call.function.name}". Available tools: ${toolNames.join(', ')}.`;
        } else if (!parsed.ok) {
          text = `Error: the arguments for ${call.function.name} are not valid JSON (${parsed.error}). Call the tool again with a single JSON object that matches its schema.`;
        } else {
          args = parsed.value;
          executed = true;
          const res = await callTool(call.function.name, parsed.value);
          const formatted = formatToolResult(res, maxResultChars, vision);
          text = formatted.text;
          images = formatted.images;
          isError = Boolean(res.isError);
        }
        const durationMs = Date.now() - t0;
        toolCalls.push({ step, id: call.id, name: call.function.name, args, isError, executed, durationMs, result: text, images: images.length });
        const status = isError ? out.style('red', 'error') : out.style('green', 'ok');
        const lines = preview(text);
        out.line(`  ${out.style('magenta', '<-')} ${status} ${out.style('dim', seconds(durationMs))}${images.length ? out.style('dim', ` | ${images.length} image(s)`) : ''}`);
        for (const l of lines) out.line(out.style('dim', `     ${l}`));
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        for (const img of images) pendingImages.push({ tool: call.function.name, ...img });
      }
      if (pendingImages.length) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `Image output from ${[...new Set(pendingImages.map((i) => i.tool))].join(', ')}:` },
            ...pendingImages.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
          ],
        });
      }
    }

    // Step budget exhausted: ask for a best-effort answer without tools.
    out.line('');
    out.line(out.style('yellow', `Reached the step limit (${maxSteps}); asking for a final answer without tools.`));
    messages.push({ role: 'user', content: 'You have used all available steps. Do not call tools. Give your best final answer now, based only on what you found, and say what is missing.' });
    let summary: string | null = null;
    try {
      const completion = await callModel(maxSteps + 1, false);
      summary = completion.content.trim() || null;
    } catch {
      summary = lastCompletion?.content.trim() || null;
    }
    if (summary) {
      out.line(out.style(['bold', 'yellow'], 'Best-effort answer (step limit reached)'));
      if (options.quiet) out.always(summary);
      else out.line(summary);
      messages.push({ role: 'assistant', content: summary });
    }
    return finalize(result('max_steps', summary, `Stopped after ${maxSteps} steps without a final answer.`));
  } catch (err) {
    const aborted = options.signal?.aborted;
    const message = err instanceof AgentError ? err.message : ((err as Error)?.stack ?? String(err));
    return finalize(result(aborted ? 'aborted' : 'error', null, aborted ? 'Aborted.' : message));
  } finally {
    if (mcp) {
      await mcp.transport.terminateSession().catch(() => undefined);
      await mcp.client.close().catch(() => undefined);
    }
  }

  function finalize(r: AgentResult): AgentResult {
    if (r.error && r.stopReason !== 'max_steps') out.error(`${out.style(['bold', 'red'], 'Error:')} ${r.error}`);
    return r;
  }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: node scripts/lmstudio-agent.ts "task" [options]

Runs a local LM Studio model as a browser agent against the Stealth Browser MCP server.

Options:
  --model <id>             LM Studio model (default: LMSTUDIO_MODEL, else the first loaded tool-use LLM)
  --max-steps <n>          model rounds before giving up (default 25)
  --reasoning <mode>       none | low | medium | high | on (default low; "on" keeps the model default)
  --tools <a,b,...>        only offer these tools
  --toolsets <g,...>       only offer tools from these groups: core, content, forms, tabs, state, debug, capture
  --no-vision              never send screenshots to the model as images
  --json <file>            write the full transcript as JSON
  --quiet                  print only the final answer
  --temperature <t>        sampling temperature (default 0.2)
  --max-tokens <n>         output token limit per model response (default 8192)
  --max-result-chars <n>   truncate tool results to this many characters (default 12000)
  --instructions <text>    extra system prompt instructions
  --mcp-url <url>          MCP endpoint (default MCP_URL or ${DEFAULT_MCP_URL})
  --lmstudio-url <url>     LM Studio server (default LMSTUDIO_URL or ${DEFAULT_LMSTUDIO_URL})
  -h, --help

Environment: MCP_URL, AUTH_TOKEN (MCP server token), LMSTUDIO_URL, LM_API_TOKEN, LMSTUDIO_MODEL, NO_COLOR.
Exit codes: 0 final answer, 1 error, 2 usage error, 3 step limit reached.`;

function csv(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function numberOption(name: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new AgentError(`--${name} must be a number >= ${min}, got "${value}"`);
  return n;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        model: { type: 'string' },
        'max-steps': { type: 'string' },
        reasoning: { type: 'string' },
        tools: { type: 'string' },
        toolsets: { type: 'string' },
        'no-vision': { type: 'boolean' },
        vision: { type: 'boolean' },
        json: { type: 'string' },
        quiet: { type: 'boolean', short: 'q' },
        temperature: { type: 'string' },
        'max-tokens': { type: 'string' },
        'max-result-chars': { type: 'string' },
        instructions: { type: 'string' },
        'mcp-url': { type: 'string' },
        'lmstudio-url': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const task = positionals.join(' ').trim();
  if (!task) {
    process.stderr.write(`Missing task.\n\n${USAGE}\n`);
    process.exit(2);
  }

  let options: AgentOptions;
  try {
    const reasoning = values.reasoning as ReasoningMode | undefined;
    if (reasoning && !REASONING_MODES.includes(reasoning)) throw new AgentError(`--reasoning must be one of ${REASONING_MODES.join(', ')}`);
    options = {
      task,
      model: values.model ?? process.env.LMSTUDIO_MODEL,
      maxSteps: numberOption('max-steps', values['max-steps'], 1),
      reasoning,
      tools: csv(values.tools),
      toolsets: csv(values.toolsets),
      vision: values['no-vision'] ? false : values.vision ? true : undefined,
      quiet: values.quiet,
      temperature: numberOption('temperature', values.temperature, 0),
      maxTokens: numberOption('max-tokens', values['max-tokens'], 64),
      maxResultChars: numberOption('max-result-chars', values['max-result-chars'], 500),
      instructions: values.instructions,
      mcpUrl: values['mcp-url'] ?? process.env.MCP_URL,
      lmstudioUrl: values['lmstudio-url'] ?? process.env.LMSTUDIO_URL,
      authToken: process.env.AUTH_TOKEN,
      lmApiToken: process.env.LM_API_TOKEN,
    };
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }

  const controller = new AbortController();
  process.once('SIGINT', () => {
    process.stderr.write('\nInterrupted; stopping...\n');
    controller.abort();
    process.once('SIGINT', () => process.exit(130));
  });
  const result = await runAgent({ ...options, signal: controller.signal });

  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ task, options: { ...options, authToken: undefined, lmApiToken: undefined, signal: undefined }, ...result }, null, 2)}\n`);
    if (!options.quiet) process.stdout.write(`Transcript written to ${values.json}\n`);
  }
  process.exitCode = result.ok ? 0 : result.stopReason === 'max_steps' ? 3 : result.stopReason === 'aborted' ? 130 : 1;
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  });
}
