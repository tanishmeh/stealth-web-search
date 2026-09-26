import * as z from 'zod';
import type { Browser } from '../browser/browser.ts';
import type { Config } from '../config.ts';
import type { AgentSummary } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import { EXTRACT_TEXT } from '../browser/scripts.ts';
import { redactArgs, runTool, type McpDeps } from '../mcp/server.ts';
import type { CallToolResult, ToolDefinition } from '../tools/types.ts';
import { summarize } from '../util/summarize.ts';
import { TokenMeter, compactTranscript, parseToolArguments, transcriptChars, truncateText } from './conversation.ts';
import { LlmAbortedError, LlmError, type ChatClient, type ChatMessage, type FunctionTool } from './llm.ts';

export type AgentKind = 'task' | 'automation' | 'finder';
/** completed: the agent delivered a result (see outcome.success); failed: it could not deliver one. */
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentInput {
  /** TASK (agentic, automation) or OBJECTIVE (finder). */
  task: string;
  /** OUTPUT: what the agent must send back. */
  output: string;
  outputFormat: 'text' | 'json';
  startUrl?: string;
  context?: string;
  maxSteps: number;
  /** Finder: distinct websites the answer must be confirmed on. */
  minSources?: number;
  /** Automation: requested script name, and whether an existing script of that name may be replaced. */
  scriptName?: string;
  overwrite?: boolean;
}

export interface StepRecord {
  step: number;
  at: string;
  llmMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  reasoning: string;
  content: string;
  toolCalls: Array<{ name: string; args: unknown; ok: boolean; durationMs: number; preview: string }>;
}

export interface CitedSource {
  n: number;
  url: string;
  title: string;
  quotes: Array<{ text: string; verified: boolean }>;
}

export interface ScriptTest {
  version: number;
  ok: boolean;
  /** Ran with the script's example parameters (the verification the host is told about). */
  withExamples: boolean;
  params: Record<string, unknown>;
  output?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  at: string;
}

/** What the finish tool recorded. */
export interface Outcome {
  success: boolean;
  output?: string;
  notes?: string;
  /** Finder */
  answer?: string;
  confidence?: 'high' | 'medium' | 'low';
  conflicts?: string;
  insufficientSources?: boolean;
  /** Automation */
  usageNotes?: string;
  verifiedByAgent?: boolean;
  /** Finished because the step or time budget ran out. */
  forced?: boolean;
}

/** One sub-agent run: its input, live state, transcript and result. */
export class AgentRun {
  readonly id: string;
  readonly kind: AgentKind;
  readonly input: AgentInput;
  readonly createdAt = new Date().toISOString();
  readonly client: string | null;
  readonly abort = new AbortController();
  status: RunStatus = 'queued';
  startedAt: string | null = null;
  endedAt: string | null = null;
  browserId: string | null = null;
  model: string | null = null;
  step = 0;
  /** Short description of what the agent is doing right now. */
  activity = 'queued';
  /** Tail of the model's current reasoning, for the dashboard. */
  thinking = '';
  readonly steps: StepRecord[] = [];
  readonly messages: ChatMessage[] = [];
  readonly usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, requests: 0 };
  readonly notes: string[] = [];
  readonly visited = new Map<string, { title: string; at: string }>();
  /** Text the agent read from each page (for checking cited quotes). */
  readonly pageTexts = new Map<string, string>();
  readonly sources: CitedSource[] = [];
  scriptName: string | null = null;
  scriptVersion = 0;
  readonly tests: ScriptTest[] = [];
  outcome: Outcome | null = null;
  error: string | null = null;
  compactions = 0;
  transcriptFile: string | null = null;
  /** When the run must end (set when it starts). */
  deadline = 0;
  /** When normal work must stop so the forced finish still fits in the budget. */
  softDeadline: () => number = () => this.deadline;
  /** The model's latest answer in plain text (used if it never calls finish). */
  lastAnswer: string | null = null;
  /** Tool-call arguments as logged (secrets masked), by call id, for the transcript. */
  readonly redactedCalls = new Map<string, string>();
  /** Extra result data a kind attaches in finalize (e.g. the saved script). */
  extra: Record<string, unknown> = {};
  private readonly listeners = new Set<(run: AgentRun) => void>();
  private settledResolve!: () => void;
  readonly settled: Promise<void>;

  constructor(id: string, kind: AgentKind, input: AgentInput, client: string | null) {
    this.id = id;
    this.kind = kind;
    this.input = input;
    this.client = client;
    this.settled = new Promise((r) => (this.settledResolve = r));
  }

  get done(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled';
  }

  get durationMs(): number {
    if (!this.startedAt) return 0;
    return (this.endedAt ? Date.parse(this.endedAt) : Date.now()) - Date.parse(this.startedAt);
  }

  onUpdate(fn: (run: AgentRun) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(): void {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch {
        // a listener must not break the run
      }
    }
  }

  /** Record the final status (the dashboard sees it at once); settle() then releases waiters. */
  finish(status: RunStatus, error: string | null = null): void {
    if (this.done) return;
    this.status = status;
    this.error = error;
    this.endedAt = new Date().toISOString();
    this.activity = status;
    this.thinking = '';
    this.update();
  }

  /** Release agent_wait callers: the result, transcript and browser cleanup are complete. */
  settle(): void {
    this.settledResolve();
  }

  /**
   * After the transcript is on disk: drop what only the model needed (messages, page texts) and
   * shorten reasoning, so finished runs kept for agent_status and the dashboard stay small.
   */
  compact(): void {
    this.messages.length = 0;
    this.pageTexts.clear();
    this.redactedCalls.clear();
    for (const st of this.steps) {
      if (st.reasoning.length > 1_500) st.reasoning = `…${st.reasoning.slice(-1_500)}`;
      if (st.content.length > 1_500) st.content = `${st.content.slice(0, 1_500)}…`;
    }
    for (const t of this.tests) {
      t.output = summarize(t.output, { maxString: 300, maxArrayItems: 10 });
      t.logs = t.logs.slice(-20);
    }
  }

  /** Dashboard/status view (no transcript). */
  summary(): AgentSummary {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      task: this.input.task.slice(0, 500),
      output: this.input.output.slice(0, 300),
      client: this.client,
      model: this.model,
      browserId: this.browserId,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      step: this.step,
      maxSteps: this.input.maxSteps,
      activity: this.activity,
      thinking: this.thinking.slice(-600),
      usage: { ...this.usage },
      notes: this.notes.length,
      sources: this.sources.length,
      script: this.scriptName ? { name: this.scriptName, version: this.scriptVersion, lastTest: this.tests.at(-1)?.ok ?? null } : null,
      result: this.outcome
        ? summarize(this.outcome.answer ?? this.outcome.output ?? '', { maxString: 400 })
        : null,
      success: this.outcome?.success ?? null,
      error: this.error,
      transcript: Boolean(this.transcriptFile),
    };
  }
}

export interface KindSpec {
  kind: AgentKind;
  /** Role name used in logs and the dashboard. */
  label: string;
  systemPrompt(run: AgentRun, config: Config): string;
  userPrompt(run: AgentRun): string;
  /** Browser tools plus the kind's own tools (finish, note, …). */
  tools(run: AgentRun, env: RunEnv): ToolDefinition<any>[];
  /** Name of the tool that ends the run. */
  finishTool: string;
  /** Work after the loop (e.g. verify the script); may set run.extra. */
  finalize?(run: AgentRun, env: RunEnv): Promise<void>;
}

export interface RunEnv {
  deps: McpDeps;
  config: Config;
  llm: ChatClient;
  browser: Browser;
  log: Logger;
  /** True once the step/time budget is exhausted and the agent must finish now. */
  forced: boolean;
}

const READING_TOOLS = new Set(['browser_markdown', 'browser_snapshot', 'browser_get_text', 'browser_search', 'browser_extract', 'browser_navigate']);
const MAX_NUDGES = 2;
const SAFETY_TOKENS = 1_024;

export function toFunctionTool(tool: ToolDefinition<any>): FunctionTool {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  schema.type = 'object';
  if (!schema.properties) schema.properties = {};
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schema } };
}

export function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of (result.content ?? []) as any[]) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') parts.push('[image omitted: you work from text; use browser_snapshot or browser_markdown to read the page]');
    else parts.push(`[${item.type} content omitted]`);
  }
  let text = parts.join('\n').trim() || (result.isError ? 'Error: the tool failed without a message' : '(no output)');
  if (result.isError && !/^error\b/i.test(text)) text = `Error: ${text}`;
  return text;
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function urlKey(url: string): string {
  return normalizeUrlKey(url);
}

/**
 * The agent loop: ask the model for the next step, run the tool calls it makes (every call goes
 * through runTool, so it is logged and shown on the dashboard), repeat until it calls its finish
 * tool or runs out of steps or time.
 */
export async function runAgentLoop(run: AgentRun, spec: KindSpec, env: RunEnv): Promise<void> {
  const { config, llm, browser, log } = env;
  const cfg = config.agent;
  const deadline = Date.now() + cfg.maxRuntimeMs;
  // The last part of the time budget is kept for the forced finish: at least a minute, or two of the
  // slowest model turns seen so far, but never more than a third of the budget.
  let slowestTurnMs = 0;
  const reserve = () => Math.min(Math.floor(cfg.maxRuntimeMs / 3), Math.max(Math.min(60_000, Math.floor(cfg.maxRuntimeMs / 4)), 2 * slowestTurnMs));
  const softDeadline = () => deadline - reserve();
  run.deadline = deadline;
  run.softDeadline = softDeadline;
  const meter = new TokenMeter();
  const client = `agent:${spec.kind} ${run.id}`;

  let tools = spec.tools(run, env);
  let toolMap = new Map(tools.map((t) => [t.name, t]));
  let fnTools = tools.map(toFunctionTool);
  const fnToolsChars = JSON.stringify(fnTools).length;

  run.messages.push({ role: 'system', content: spec.systemPrompt(run, config) }, { role: 'user', content: spec.userPrompt(run) });

  let nudges = 0;
  let lastCalls: string[] = [];
  let forceFinish = false;
  let timeUp = false;
  let forcedAttempts = 0;
  let overflowRetries = 0;
  /** Lowered when the endpoint reports a smaller context window than AGENT_CONTEXT_TOKENS. */
  let contextTokens = cfg.contextTokens;

  const budgetChars = () => Math.floor((contextTokens - cfg.maxOutputTokens - SAFETY_TOKENS) * meter.charsPerToken) - fnToolsChars;

  /** Remember what the agent read on this page (the page's own text, not tool output), to check cited quotes. */
  const capturePageText = async () => {
    const tab = browser.activeTab;
    if (!tab || tab.closed || !/^https?:/i.test(tab.url)) return;
    const live = await browser.mutex.run(() => tab.callFunction<string | null>(EXTRACT_TEXT, [null])).catch(() => null);
    if (!live) return;
    const key = urlKey(tab.url);
    const prev = run.pageTexts.get(key) ?? '';
    run.pageTexts.set(key, prev.includes(live) ? prev : `${prev}\n${live}`.slice(-400_000));
  };

  const executeCall = async (call: { id: string; name: string; arguments: string }, record: StepRecord): Promise<string> => {
    const started = Date.now();
    const def = toolMap.get(call.name);
    const note = (text: string, ok: boolean, args: unknown = call.arguments) => {
      record.toolCalls.push({ name: call.name, args: summarize(args, { maxString: 300 }), ok, durationMs: Date.now() - started, preview: text.slice(0, 300) });
      return text;
    };
    if (!def) {
      return note(`Error: unknown tool "${call.name}". Available tools: ${[...toolMap.keys()].join(', ')}`, false);
    }
    const parsed = parseToolArguments(call.arguments);
    if (!parsed.ok) return note(`Error: the arguments are not valid JSON (${parsed.error}). Send one JSON object.`, false);
    const checked = def.inputSchema.safeParse(parsed.value);
    if (!checked.success) {
      const issues = checked.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return note(`Error: invalid arguments for ${call.name}: ${issues}`, false, parsed.value);
    }
    // what logs, the dashboard and the transcript get to see (passwords typed into fields are masked)
    const shown = redactArgs(call.name, parsed.value, browser, config.log.redactSecrets).args as Record<string, unknown>;
    if (shown !== parsed.value) run.redactedCalls.set(call.id, JSON.stringify(shown));
    run.activity = `${call.name} ${describeArgs(shown)}`.trim();
    run.update();
    const result = await runTool(def, checked.data, null, env.deps, { browser, client, agentRunId: run.id, signal: run.abort.signal });
    let text = truncateText(resultText(result), cfg.maxResultChars);
    const tab = browser.activeTab;
    if (tab && /^https?:/i.test(tab.url) && call.name !== 'web_search') {
      run.visited.set(urlKey(tab.url), { title: tab.title, at: new Date().toISOString() });
      // the finder's cited quotes are checked against what the pages it read really say
      if (run.kind === 'finder' && READING_TOOLS.has(call.name) && !result.isError) await capturePageText();
    }
    // repeated identical calls: tell the model the result will not change
    const signature = `${call.name} ${JSON.stringify(parsed.value)}`;
    lastCalls = [...lastCalls.slice(-2), signature];
    if (lastCalls.length === 3 && lastCalls.every((c) => c === signature)) {
      text += '\nNote: you made this exact call three times in a row. Its result will not change; try a different approach.';
    }
    return note(text, !result.isError, shown);
  };

  for (;;) {
    if (run.abort.signal.aborted) throw new LlmAbortedError();
    if (run.outcome) break;
    const outOfSteps = run.step >= run.input.maxSteps;
    const outOfTime = timeUp || Date.now() > softDeadline();
    if ((outOfSteps || outOfTime || forceFinish) && !env.forced) {
      // last chance: only the finish tool, and the model must call it
      env.forced = true;
      // Only the finish tool is accepted from now on (tool_choice forces it). The tool list sent to
      // the model stays the same, so the endpoint can reuse its prompt cache for this last turn.
      toolMap = new Map(tools.filter((t) => t.name === spec.finishTool).map((t) => [t.name, t]));
      const why = forceFinish ? 'You keep answering without calling a tool.' : outOfSteps ? `You have used all ${run.input.maxSteps} steps.` : 'You are out of time.';
      run.messages.push({
        role: 'user',
        content: `${why} Call ${spec.finishTool} now with the best result you have from the work so far, and say clearly in notes what is missing or unverified. Report success only if the job is really complete.`,
      });
      log.info({ runId: run.id, reason: why }, 'agent must finish now');
    } else if (env.forced && (++forcedAttempts > 3 || Date.now() > deadline)) {
      run.outcome = fallbackOutcome(run, `the model did not call ${spec.finishTool} within the budget (${run.input.maxSteps} steps, ${Math.round(cfg.maxRuntimeMs / 60_000)} min)`);
      break;
    }

    // keep the transcript inside the context window
    const budget = budgetChars();
    if (transcriptChars(run.messages) > budget) {
      const report = compactTranscript(run.messages, Math.floor(budget * 0.85), () => run.notes.map((n, i) => `${i + 1}. ${n}`).join('\n'));
      run.compactions++;
      log.info({ runId: run.id, ...report, budgetChars: budget }, 'compacted agent transcript to fit the context window');
    }

    run.step++;
    const record: StepRecord = {
      step: run.step,
      at: new Date().toISOString(),
      llmMs: 0,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      finishReason: null,
      reasoning: '',
      content: '',
      toolCalls: [],
    };
    run.steps.push(record);
    run.activity = 'thinking';
    run.thinking = '';
    run.update();

    let lastPush = 0;
    // normal steps stop at the soft deadline; the forced finish gets at least the reserve
    // the forced finish may run at most a minute past the budget
    const stepTimeout = AbortSignal.timeout(
      env.forced ? Math.max(deadline - Date.now(), Math.min(reserve(), 60_000)) : Math.max(5_000, softDeadline() - Date.now()),
    );
    const signal = AbortSignal.any([run.abort.signal, stepTimeout]);
    let completion;
    try {
      completion = await llm.complete({
        messages: run.messages,
        tools: fnTools,
        toolChoice: env.forced ? { type: 'function', function: { name: spec.finishTool } } : 'auto',
        signal,
        logContext: { runId: run.id, kind: run.kind, step: run.step },
        redactToolCall: (name, args) => {
          // parse like the loop does (fences, text around the object) so what runs is also what gets masked
          const value = typeof args === 'string' ? parseToolArguments(args) : null;
          const obj = value ? (value.ok ? value.value : null) : args;
          if (obj && typeof obj === 'object') return redactArgs(name, obj as Record<string, any>, browser, config.log.redactSecrets).args;
          return config.log.redactSecrets && typeof args === 'string' ? '[unparsed arguments not logged]' : args;
        },
        onDelta: (kind, text) => {
          if (kind !== 'reasoning') return;
          run.thinking = (run.thinking + text).slice(-2_000);
          if (Date.now() - lastPush > 700) {
            lastPush = Date.now();
            run.update();
          }
        },
      });
    } catch (err) {
      if (run.abort.signal.aborted) throw new LlmAbortedError();
      if (err instanceof LlmError && err.contextOverflow && run.messages.length > 3) {
        overflowRetries++;
        // the endpoint may say how large its window really is: use that from now on
        const reported = Number(/maximum context length is (\d+)/i.exec(err.message)?.[1] ?? /max_model_len[^\d]*(\d+)/i.exec(err.message)?.[1] ?? NaN);
        let lowered = false;
        if (reported > 2 * cfg.maxOutputTokens && reported < contextTokens) {
          contextTokens = reported;
          lowered = true;
        }
        const report = compactTranscript(run.messages, Math.floor(budgetChars() * (overflowRetries === 1 ? 0.6 : 0.4)), () => run.notes.join('\n'));
        run.compactions++;
        if (overflowRetries <= 2 && (lowered || report.afterChars < report.beforeChars)) {
          log.warn({ runId: run.id, ...report, contextTokens, attempt: overflowRetries }, 'the model reported a context overflow; compacted harder and retrying');
          run.step--;
          run.steps.pop();
          continue;
        }
        throw new LlmError(
          `the model's context window is smaller than this run needs (AGENT_CONTEXT_TOKENS=${cfg.contextTokens}): ${err.message.slice(0, 300)}. ` +
            'Lower AGENT_CONTEXT_TOKENS (and AGENT_MAX_OUTPUT_TOKENS) or load the model with a larger context.',
        );
      }
      if (stepTimeout.aborted && !env.forced) {
        // out of time mid-step: let the model report what it has
        timeUp = true;
        record.finishReason = 'timeout';
        continue;
      }
      if (stepTimeout.aborted && env.forced) {
        // even the final turn ran out of time: report what the agent had saved
        run.outcome = fallbackOutcome(run, `the model did not finish within the time budget (AGENT_MAX_RUNTIME_MS=${cfg.maxRuntimeMs})`);
        break;
      }
      if (signal.aborted) throw new LlmError(`the agent ran out of time (${Math.round(cfg.maxRuntimeMs / 60_000)} min, AGENT_MAX_RUNTIME_MS)`);
      throw err;
    }
    overflowRetries = 0;
    slowestTurnMs = Math.max(slowestTurnMs, completion.durationMs);
    run.model = completion.model;
    record.llmMs = completion.durationMs;
    record.finishReason = completion.finishReason;
    record.reasoning = completion.reasoning;
    record.content = completion.content;
    if (completion.usage) {
      record.promptTokens = completion.usage.promptTokens;
      record.completionTokens = completion.usage.completionTokens;
      record.reasoningTokens = completion.usage.reasoningTokens;
      run.usage.promptTokens += completion.usage.promptTokens;
      run.usage.completionTokens += completion.usage.completionTokens;
      run.usage.reasoningTokens += completion.usage.reasoningTokens;
      meter.observe(completion.promptChars, completion.usage.promptTokens);
    }
    run.usage.requests++;

    if (completion.toolCalls.length === 0) {
      const content = completion.content.trim();
      // an empty assistant turn is not sent back (strict endpoints reject content null without tool calls)
      if (content) {
        run.messages.push({ role: 'assistant', content, reasoning: completion.reasoning });
        run.lastAnswer = content;
      }
      if (env.forced) {
        // endpoints that ignore tool_choice (llama.cpp, Ollama) may still answer in text
        run.messages.push({
          role: 'user',
          content: `Only ${spec.finishTool} is accepted now; a text answer does not reach the host. Call ${spec.finishTool} with your result.`,
        });
        continue;
      }
      if (completion.finishReason === 'length') {
        run.messages.push({
          role: 'user',
          content: 'Your last response was cut off because it was too long. Keep your reasoning short and act: call one tool now.',
        });
        continue;
      }
      nudges++;
      if (nudges > MAX_NUDGES) {
        forceFinish = true;
        continue;
      }
      run.messages.push({
        role: 'user',
        content: `You did not call a tool. Keep working with the tools, or if the job is done call ${spec.finishTool} with the result (the host only receives what you pass to ${spec.finishTool}).`,
      });
      continue;
    }

    nudges = 0; // only consecutive answers without a tool call count
    run.messages.push({
      role: 'assistant',
      content: completion.content.trim() || null,
      reasoning: completion.reasoning,
      // arguments go back to the model as strict JSON: endpoints such as vLLM reject a transcript with malformed ones
      tool_calls: completion.toolCalls.map((c) => {
        const p = parseToolArguments(c.arguments);
        return { id: c.id, type: 'function' as const, function: { name: c.name, arguments: p.ok ? JSON.stringify(p.value) : '{}' } };
      }),
    });
    for (const call of completion.toolCalls) {
      let text: string;
      if (run.outcome) text = 'Skipped: the job was already finished.';
      else if (run.abort.signal.aborted) text = 'Skipped: the run was cancelled.';
      else if (!env.forced && call.name !== spec.finishTool && Date.now() > softDeadline()) text = `Skipped: out of time. Call ${spec.finishTool} with what you have.`;
      else {
        try {
          text = await executeCall(call, record);
        } catch (err) {
          text = `Error: ${(err as Error).message}`;
          record.toolCalls.push({ name: call.name, args: '(not shown)', ok: false, durationMs: 0, preview: text.slice(0, 300) });
        }
      }
      run.messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
    run.update();
  }
}

/** A result made from the agent's saved notes when it could not deliver one itself. */
function fallbackOutcome(run: AgentRun, why: string): Outcome {
  const saved = run.notes.length ? run.notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(nothing was saved)';
  const last = run.lastAnswer ? `\nLast answer the model gave in plain text (not through finish; unverified):\n${run.lastAnswer.slice(0, 4_000)}` : '';
  const text = `No final result: ${why}. What the agent had noted:\n${saved}${last}`;
  return run.kind === 'finder'
    ? { success: false, forced: true, answer: text, confidence: 'low', insufficientSources: true, notes: why }
    : { success: false, forced: true, output: text, notes: why };
}

function describeArgs(args: Record<string, unknown>): string {
  // no typed text or keys: those are shown as [REDACTED] in logs when they are secret
  const pick = args.url ?? args.query ?? args.ref ?? args.selector ?? args.name;
  if (typeof pick !== 'string') return '';
  return pick.length > 80 ? `${pick.slice(0, 77)}...` : pick;
}
