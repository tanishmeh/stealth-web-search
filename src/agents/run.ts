import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { Browser } from '../browser/browser.ts';
import type { Config } from '../config.ts';
import type { AgentSummary } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import { EXTRACT_TEXT } from '../browser/scripts.ts';
import { redactArgs, runTool, type McpDeps } from '../mcp/server.ts';
import type { CallToolResult, ToolDefinition } from '../tools/types.ts';
import { MAX_WAITING } from '../util/limits.ts';
import { REDACTED, scrubDeep, scrubText, secretParts } from '../util/scrub.ts';
import { summarize } from '../util/summarize.ts';
import { TokenMeter, compactTranscript, parseToolArguments, transcriptChars, truncateText } from './conversation.ts';
import { LlmAbortedError, LlmError, type ChatClient, type ChatMessage, type FunctionTool } from './llm.ts';

export type AgentKind = 'task' | 'automation' | 'finder';
/**
 * completed: the agent delivered a result (see outcome.success); failed: it could not deliver one;
 * waiting: paused on a question to the host (ask_host) until agent_reply, the reply timeout or a cancel.
 */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

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
  /** Task and automation: the agent may pause and ask the host a question (default true; see questionsAllowed). */
  allowQuestions?: boolean;
  /**
   * Task and automation: what the user already approved for this job, in their words (purchase_approval).
   * The agent still asks before it places an order or pays; the host checks the question against this
   * and approves a matching checkout itself. Not a secret: logs and the dashboard show it.
   */
  purchaseApproval?: string;
  /** Task: name of the snapshot (saved sign-in) the agent's browser starts with. Names only, never cookie data. */
  snapshot?: string;
  /** Refresh that snapshot from the agent's browser when the run completes successfully (default true). */
  updateSnapshot?: boolean;
  /** Offer browser_evaluate although the run started with a snapshot (default false). */
  allowEvaluate?: boolean;
}

/** What became of a saved sign-in in a run: saved by it (created, refreshed), or why it was not refreshed. */
export interface SnapshotSaved {
  name: string;
  version: number | null;
  action: 'created' | 'refreshed' | 'skipped';
  reason?: string;
}

export type QuestionReason = 'confirm' | 'choose' | 'sign_in' | 'missing_info';

/** A question the sub-agent asked the host with ask_host. */
export interface AgentQuestion {
  id: string;
  text: string;
  options: string[];
  reason: QuestionReason;
  /** The answer is a code or other secret: its text is never stored, only handed to the model. */
  secret: boolean;
  step: number;
  askedAt: string;
  expiresAt: string;
  /** The agent browser's page when it asked, read by the server (never taken from the model). */
  pageUrl: string | null;
  origin: string | null;
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  /** The answer; null while pending, when none came, and always for a secret answer. */
  answer: string | null;
  /** Length of a secret answer (its text is not kept). */
  answerChars?: number;
  answeredAt: string | null;
  /** Client that answered (agent_reply). */
  answeredBy: string | null;
}

/** How a pending question was closed. `answer` is the real text (also when secret): it goes to the model only. */
export interface QuestionOutcome {
  status: 'answered' | 'expired' | 'cancelled';
  answer: string | null;
  secret: boolean;
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
  /** The question waiting for the host's answer (status 'waiting'), or null. */
  question: AgentQuestion | null = null;
  /** Closed questions, oldest first (a secret answer is never kept). */
  readonly questions: AgentQuestion[] = [];
  /** Model turns that asked a question and paused: they do not count against max_steps. */
  questionTurns = 0;
  /** The step of the last question (a turn counts as a question turn once). */
  private lastAskStep = -1;
  /** Time paused on questions (asked → slot taken again); it moves the deadline. */
  pausedMs = 0;
  /** When the current pause began (ms), or null. */
  pausedSince: number | null = null;
  /** Text of the host's secret answers (one-time codes…): masked wherever the run is logged or shown. */
  readonly secretValues = new Set<string>();
  /** Tool results as shown outside the model's own transcript (a secret answer masked), by call id. */
  readonly redactedResults = new Map<string, string>();
  /** The snapshot (saved sign-in) the browser started with, as loaded (the prompt shows it as quoted data). */
  snapshot: { name: string; version: number; description: string; cookieDomains: string[] } | null = null;
  /** A sign-in the run saved (save_sign_in, or the refresh at the end), or why its snapshot was not refreshed. */
  snapshotSaved: SnapshotSaved | null = null;
  /** Snapshots of this run the user deleted meanwhile: the run never saves them again. */
  readonly deletedSnapshots = new Set<string>();
  /** `text` with the host's secret answers replaced by [REDACTED]. */
  readonly scrub = (text: string): string => scrubText(text, this.secretValues);
  private answerWaiter: { settle: (outcome: QuestionOutcome) => void; timer: NodeJS.Timeout; offAbort: () => void } | null = null;
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

  /** Paused on an unanswered question and not being cancelled. */
  get isWaiting(): boolean {
    return this.question !== null && !this.abort.signal.aborted;
  }

  /** Steps counted against max_steps: turns that paused on a question are free. */
  get stepsUsed(): number {
    return this.step - this.questionTurns;
  }

  /** Time paused on questions so far, including a pause in progress. */
  get waitingMs(): number {
    return this.pausedMs + (this.pausedSince === null ? 0 : Date.now() - this.pausedSince);
  }

  /** A copy of `value` with the host's secret answers masked in every string. */
  scrubbed<T>(value: T): T {
    return this.secretValues.size ? scrubDeep(value, this.scrub) : value;
  }

  /**
   * Pause on a question to the host: the run is 'waiting' until closeQuestion() (an answer, the
   * reply timeout or a cancel), which settles the returned promise.
   */
  ask(q: Pick<AgentQuestion, 'text' | 'options' | 'reason' | 'secret' | 'pageUrl'>, timeoutMs: number): Promise<QuestionOutcome> {
    const now = Date.now();
    let origin: string | null = null;
    try {
      origin = q.pageUrl ? new URL(q.pageUrl).origin : null;
    } catch {
      origin = null;
    }
    // stored as shown to the host and the dashboard: an earlier secret answer the agent quotes is masked
    this.question = {
      id: `q${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      ...q,
      text: this.scrub(q.text),
      options: q.options.map(this.scrub),
      pageUrl: q.pageUrl && this.scrub(q.pageUrl),
      origin: origin && this.scrub(origin),
      step: this.step,
      askedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
      status: 'pending',
      answer: null,
      answeredAt: null,
      answeredBy: null,
    };
    this.status = 'waiting';
    this.activity = "waiting for the host's answer";
    this.thinking = '';
    // a model turn is free once, however many questions it paused on
    if (this.lastAskStep !== this.step) {
      this.questionTurns++;
      this.lastAskStep = this.step;
    }
    this.pausedSince = now;
    const closed = new Promise<QuestionOutcome>((settle) => {
      const onAbort = () => this.closeQuestion('cancelled');
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => this.closeQuestion('expired'), timeoutMs);
      this.answerWaiter = { settle, timer, offAbort: () => this.abort.signal.removeEventListener('abort', onAbort) };
    });
    this.update();
    if (this.abort.signal.aborted) this.closeQuestion('cancelled');
    return closed;
  }

  /**
   * Close the pending question, synchronously: record it (a secret answer's text is never kept), mark
   * the run running again and publish that, and only then release the paused ask_host call, so every
   * reader (agent_reply's own wait, agent_status, the dashboard) already sees the new state.
   */
  closeQuestion(status: QuestionOutcome['status'], reply?: { answer: string; secret?: boolean; by: string | null }): AgentQuestion | null {
    const q = this.question;
    const waiter = this.answerWaiter;
    if (!q || !waiter) return null;
    this.question = null;
    this.answerWaiter = null;
    clearTimeout(waiter.timer);
    waiter.offAbort();
    const answer = status === 'answered' && reply ? reply.answer : null;
    const secret = q.secret || Boolean(reply?.secret);
    // the answer and its code-like parts (the agent may type just the code of "The code is 482913.")
    if (answer !== null && secret) for (const part of secretParts(answer)) this.secretValues.add(part);
    const record: AgentQuestion = {
      ...q,
      secret,
      status,
      answer: secret ? null : answer,
      answeredAt: answer !== null ? new Date().toISOString() : null,
      answeredBy: reply?.by ?? null,
    };
    if (secret && answer !== null) record.answerChars = answer.length;
    this.questions.push(record);
    this.status = 'running';
    this.activity = status === 'cancelled' ? 'stopping' : 'resuming: waiting for a free agent slot';
    this.update();
    waiter.settle({ status, answer, secret });
    return record;
  }

  /** The run holds a slot again after a question: the paused time moves the deadline (the one place it does). */
  endPause(): void {
    if (this.pausedSince === null) return;
    const paused = Date.now() - this.pausedSince;
    this.pausedSince = null;
    this.deadline += paused;
    this.pausedMs += paused;
  }

  /** Every question of the run, the pending one last (for the dashboard and the transcript; secret answers are not in them). */
  questionLog(): AgentQuestion[] {
    return this.question ? [...this.questions, { ...this.question }] : [...this.questions];
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
    this.endPause();
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
    this.redactedResults.clear();
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
    const q = this.isWaiting ? this.question : null;
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
      stepsUsed: this.stepsUsed,
      maxSteps: this.input.maxSteps,
      activity: this.activity,
      thinking: this.scrub(this.thinking).slice(-600),
      question: q ? { id: q.id, text: q.text, options: q.options, reason: q.reason, secret: q.secret, origin: q.origin, askedAt: q.askedAt, expiresAt: q.expiresAt } : null,
      questions: this.questions.length + (this.question ? 1 : 0),
      waitingMs: this.waitingMs,
      usage: { ...this.usage },
      notes: this.notes.length,
      sources: this.sources.length,
      script: this.scriptName ? { name: this.scriptName, version: this.scriptVersion, lastTest: this.tests.at(-1)?.ok ?? null } : null,
      snapshot: this.snapshot ? { name: this.snapshot.name, version: this.snapshot.version } : null,
      snapshotSaved: this.snapshotSaved,
      purchaseApproval: this.input.purchaseApproval ?? null,
      result: this.outcome
        ? summarize(this.scrub(this.outcome.answer ?? this.outcome.output ?? ''), { maxString: 400 })
        : null,
      success: this.outcome?.success ?? null,
      error: this.error && this.scrub(this.error),
      transcript: Boolean(this.transcriptFile),
    };
  }
}

export interface KindSpec {
  kind: AgentKind;
  /** Role name used in logs and the dashboard. */
  label: string;
  systemPrompt(run: AgentRun, config: Config): string;
  userPrompt(run: AgentRun, config: Config): string;
  /** Browser tools plus the kind's own tools (finish, note, …). */
  tools(run: AgentRun, env: RunEnv): ToolDefinition<any>[];
  /** Name of the tool that ends the run. */
  finishTool: string;
  /** Work after the loop (e.g. verify the script); may set run.extra. */
  finalize?(run: AgentRun, env: RunEnv): Promise<void>;
  /** A check the browser tools run on the label of a control, and the page it is on, before they activate it (see ToolContext.purchaseGuard). */
  purchaseGuard?(run: AgentRun, env: RunEnv): (label: string, pageUrl: string) => string | null;
}

export interface RunEnv {
  deps: McpDeps;
  config: Config;
  llm: ChatClient;
  browser: Browser;
  log: Logger;
  /** True once the step/time budget is exhausted and the agent must finish now. */
  forced: boolean;
  /** Give the run's concurrency slot up while it waits for the host (its browser stays open). */
  pause(): void;
  /** Take a slot again, ahead of queued runs; false when the run was cancelled meanwhile. */
  resume(signal: AbortSignal): Promise<boolean>;
  /** Runs paused on a question right now (at most MAX_WAITING). */
  waitingCount(): number;
}

/** Whether a run may ask the host questions: ask_host is offered and the prompt says so (never the finder). */
export function questionsAllowed(run: AgentRun, config: Config): boolean {
  return run.kind !== 'finder' && config.agent.maxQuestions > 0 && run.input.allowQuestions !== false;
}

/**
 * Why ask_host cannot pause the run now (the call then counts as a normal step), or null. A step that
 * needed the host's approval or a sign-in code is never left to the agent's own decision.
 */
export function questionRefusal(run: AgentRun, env: RunEnv, reason: QuestionReason | undefined): string | null {
  const max = env.config.agent.maxQuestions;
  const next =
    reason === 'confirm'
      ? "Do not take the step you wanted to confirm (do not place the order or pay): call finish with success=false and say what needs the host's approval."
      : reason === 'sign_in'
        ? 'Call finish with success=false and say which site needs a sign-in and what it asks for.'
        : "Decide on your own from what the TASK says, or call finish with success=false and say what needs the host's decision.";
  const asked = run.questions.length + (run.question ? 1 : 0);
  if (asked >= max) return `you already asked ${max} question${max === 1 ? '' : 's'}, the limit for one job. ${next}`;
  if (env.waitingCount() >= MAX_WAITING) return `too many jobs are waiting for the host right now (${MAX_WAITING}). ${next}`;
  if (run.input.maxSteps - run.stepsUsed < 3 || run.softDeadline() - Date.now() < 120_000) {
    return 'too little budget left to act on an answer; finish with success=false and say what needs approval';
  }
  return null;
}

/** An amount of money: "$17.49", "US$ 17", "EUR 17", "17,49". */
const MONEY = String.raw`(?:(?:[a-z]{1,3} ?)?[$€£¥₹] ?\d|(?:usd|eur|gbp|cad|aud|chf|jpy|inr) ?\d|\d[\d,.]*[.,]\d{2}\b)`;
/** A one-word label stands alone or goes on with "now" or an amount ("Purchase", "Donate $25"; not "Purchase history"). */
const ALONE = String.raw`(?: now)?(?=[ !.:·–—-]*(?:$|(?:for )?${MONEY}))`;
const FINAL_PURCHASE = new RegExp(
  `^(?:${[
    String.raw`place (?:(?:your|my|the) )?order\b`,
    String.raw`buy (?:it )?now\b`,
    String.raw`order now\b`,
    String.raw`complete (?:(?:your|my) )?(?:purchase|order|payment|checkout)\b`,
    String.raw`confirm (?:and pay|(?:(?:your|my) )?(?:order|purchase|payment))\b`,
    String.raw`submit (?:(?:your|my) )?order\b`,
    String.raw`finish (?:order|purchase|checkout)\b`,
    String.raw`pay(?: now\b| ${MONEY}|(?=[ !.]*$))`,
    `purchase${ALONE}`,
    `donate${ALONE}`,
    String.raw`(?:send|transfer) money\b`,
    `send ${MONEY}`,
  ].join('|')})`,
  'i',
);

/**
 * Whether a control's label looks like the final step of an order or payment ("Place your order",
 * "Pay $17.49", "Buy now"), matched at the start of the label. "Proceed to checkout", "Add to cart",
 * "Continue to payment" or "PayPal" do not.
 */
export function looksLikeFinalPurchase(label: string): boolean {
  const text = label.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 200);
  return FINAL_PURCHASE.test(text);
}

/**
 * The purchase guard of a task or automation run (the finder does research, the scripts an automation
 * run saves and tests are not checked), defense in depth behind the prompt's rule to ask first: a click on
 * (or Enter/Space onto) a control that looks like the final step of an order or payment is refused until
 * the host answered a confirm question asked on that page. It is always on: a purchase the user approved
 * in advance (purchase_approval) is still asked about, and the host approves it. Any answer lifts it on
 * that page: the agent is trusted to respect a "No". Page scripts (browser_evaluate, which a task run
 * started with a snapshot gets only with allow_evaluate) are not checked.
 */
export function purchaseGuardFor(run: AgentRun, env: RunEnv): (label: string, pageUrl: string) => string | null {
  return (label, pageUrl) => {
    if (!looksLikeFinalPurchase(label)) return null;
    const approved = run.questions.filter((q) => q.reason === 'confirm' && q.status === 'answered');
    // an approval counts on the page it was asked on, where the total, the address and the payment method were shown
    if (approved.some((q) => samePage(q.pageUrl, pageUrl))) return null;
    const shown = JSON.stringify(run.scrub(clip(label.replace(/\s+/g, ' ').trim(), 80)));
    const elsewhere = approved.at(-1)?.pageUrl ?? null;
    env.log.warn({ label: shown, approvedOn: elsewhere }, 'blocked the final step of an order or payment: the host has not approved it');
    if (!questionsAllowed(run, env.config)) {
      return `Blocked: ${shown} looks like the final step of an order or payment, and this job needs the host's approval for it but questions are off. Call finish with success=false and say the order is ready to be placed (item, total, address, payment method).`;
    }
    if (approved.length) {
      return `Blocked: ${shown} looks like the final step of an order or payment, and the host's approval was for a question you asked on another page (${elsewhere ?? 'unknown'}). Ask again on this page: call ask_host with reason "confirm", giving the item, the total price, the delivery address and the payment method it shows. Click it again after the host approves.`;
    }
    return `Blocked: ${shown} looks like the final step of an order or payment. Ask the host first: call ask_host with reason "confirm", giving the item, the total price, the delivery address and the payment method. Click it again after the host approves.`;
  };
}

/** Same page for the purchase guard: same origin and path (the query and the fragment may differ). */
function samePage(a: string | null, b: string): boolean {
  if (!a) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/';
    return x.origin === y.origin && path(x) === path(y);
  } catch {
    return false;
  }
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
  // run.deadline is the one deadline: time paused on a question moves it (AgentRun.endPause)
  run.deadline = Date.now() + cfg.maxRuntimeMs;
  // The last part of the time budget is kept for the forced finish: at least a minute, or two of the
  // slowest model turns seen so far, but never more than a third of the budget.
  let slowestTurnMs = 0;
  const reserve = () => Math.min(Math.floor(cfg.maxRuntimeMs / 3), Math.max(Math.min(60_000, Math.floor(cfg.maxRuntimeMs / 4)), 2 * slowestTurnMs));
  const softDeadline = () => run.deadline - reserve();
  run.softDeadline = softDeadline;
  const meter = new TokenMeter();
  const client = `agent:${spec.kind} ${run.id}`;

  let tools = spec.tools(run, env);
  let toolMap = new Map(tools.map((t) => [t.name, t]));
  let fnTools = tools.map(toFunctionTool);
  const fnToolsChars = JSON.stringify(fnTools).length;
  const canAsk = toolMap.has('ask_host');
  const purchaseGuard = spec.purchaseGuard?.(run, env);

  run.messages.push({ role: 'system', content: spec.systemPrompt(run, config) }, { role: 'user', content: spec.userPrompt(run, config) });

  let nudges = 0;
  let lastCalls: string[] = [];
  let forceFinish = false;
  let timeUp = false;
  let forcedAttempts = 0;
  let overflowRetries = 0;
  /** Lowered when the endpoint reports a smaller context window than AGENT_CONTEXT_TOKENS. */
  let contextTokens = cfg.contextTokens;

  const budgetChars = () => Math.floor((contextTokens - cfg.maxOutputTokens - SAFETY_TOKENS) * meter.charsPerToken) - fnToolsChars;

  /** What compaction keeps: the agent's notes, and the host's answers (a secret one only as a mention). */
  const pinned = (numbered: boolean) => () => {
    const notes = run.notes.map((n, i) => (numbered ? `${i + 1}. ${n}` : n));
    const answers = run.questions
      .filter((q) => q.status === 'answered')
      .map((q) => `Q: ${clip(q.text, 300)} A: ${q.secret ? '[secret answer given]' : clip(q.answer ?? '', 1_000)}`);
    return [...notes, ...(answers.length ? ["The host's answers to your questions:", ...answers] : [])].join('\n');
  };

  /** An ask_host call will really ask (and pause): valid, not refused, in normal work time. */
  const willAsk = (call: { arguments: string }): boolean => {
    const def = toolMap.get('ask_host');
    if (!def || env.forced || run.outcome || Date.now() > softDeadline()) return false;
    const parsed = parseToolArguments(call.arguments);
    const checked = parsed.ok ? def.inputSchema.safeParse(parsed.value) : null;
    if (!checked?.success) return false;
    return questionRefusal(run, env, (checked.data as { reason: QuestionReason }).reason) === null;
  };

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
    // the step record is served to the dashboard and written to the transcript: secrets masked
    const note = (text: string, ok: boolean, args: unknown = call.arguments, shownText = text) => {
      record.toolCalls.push({ name: call.name, args: summarize(run.scrubbed(args), { maxString: 300 }), ok, durationMs: Date.now() - started, preview: run.scrub(shownText).slice(0, 300) });
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
    const shown = run.scrubbed(redactArgs(call.name, parsed.value, browser, config.log.redactSecrets).args as Record<string, unknown>);
    if (shown !== parsed.value) run.redactedCalls.set(call.id, JSON.stringify(shown));
    run.activity = `${call.name} ${describeArgs(shown)}`.trim();
    run.update();
    const closedBefore = run.questions.length;
    const result = await runTool(def, checked.data, null, env.deps, { browser, client, agentRunId: run.id, signal: run.abort.signal, scrub: run.scrub, purchaseGuard });
    let text = truncateText(resultText(result), cfg.maxResultChars);
    // a secret answer reaches the model only: the step preview and the transcript show it masked
    const closed = run.questions.length > closedBefore ? run.questions.at(-1) : undefined;
    const masked = closed?.secret && closed.status === 'answered' ? `The host answered: ${REDACTED}` : undefined;
    if (masked) run.redactedResults.set(call.id, masked);
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
    return note(text, !result.isError, shown, masked);
  };

  for (;;) {
    if (run.abort.signal.aborted) throw new LlmAbortedError();
    if (run.outcome) break;
    const outOfSteps = run.stepsUsed >= run.input.maxSteps;
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
    } else if (env.forced && (++forcedAttempts > 3 || Date.now() > run.deadline)) {
      run.outcome = fallbackOutcome(run, `the model did not call ${spec.finishTool} within the budget (${run.input.maxSteps} steps, ${Math.round(cfg.maxRuntimeMs / 60_000)} min)`);
      break;
    }

    // keep the transcript inside the context window
    const budget = budgetChars();
    if (transcriptChars(run.messages) > budget) {
      const report = compactTranscript(run.messages, Math.floor(budget * 0.85), pinned(true));
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
      env.forced ? Math.max(run.deadline - Date.now(), Math.min(reserve(), 60_000)) : Math.max(5_000, softDeadline() - Date.now()),
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
          if (obj && typeof obj === 'object') return run.scrubbed(redactArgs(name, obj as Record<string, any>, browser, config.log.redactSecrets).args);
          return config.log.redactSecrets && typeof args === 'string' ? '[unparsed arguments not logged]' : run.scrubbed(args);
        },
        scrubLog: run.scrub,
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
        const report = compactTranscript(run.messages, Math.floor(budgetChars() * (overflowRetries === 1 ? 0.6 : 0.4)), pinned(false));
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
    record.reasoning = run.scrub(completion.reasoning);
    record.content = run.scrub(completion.content);
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
          content:
            `Only ${spec.finishTool} is accepted now; a text answer does not reach the host. Call ${spec.finishTool} with your result.` +
            (canAsk ? ` If you needed the host's answer, call ${spec.finishTool} with success=false and say in notes what you needed.` : ''),
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
        content: canAsk
          ? // small models often ask in plain text: point them at ask_host instead of pushing them to finish
            `You did not call a tool. Text answers do not reach the host. If you need the host's answer, call ask_host with your question; otherwise continue with the tools or call ${spec.finishTool} (the host only receives what you pass to ${spec.finishTool}).`
          : `You did not call a tool. Keep working with the tools, or if the job is done call ${spec.finishTool} with the result (the host only receives what you pass to ${spec.finishTool}).`,
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
    // A question pauses the turn: when an ask_host call will really ask, only the first such call runs (a
    // click listed next to it could place the order before the host answered, and a turn pauses at most
    // once). Otherwise the turn runs as usual.
    const asking = completion.toolCalls.find((c) => c.name === 'ask_host' && willAsk(c)) ?? null;
    for (const call of completion.toolCalls) {
      let text: string;
      if (run.outcome) text = 'Skipped: the job was already finished.';
      else if (run.abort.signal.aborted) text = 'Skipped: the run was cancelled.';
      else if (asking && call !== asking) text = 'Skipped: you asked the host a question in this turn. Wait for the answer, then act.';
      else if (!env.forced && call.name !== spec.finishTool && Date.now() > softDeadline()) text = `Skipped: out of time. Call ${spec.finishTool} with what you have.`;
      else {
        try {
          text = await executeCall(call, record);
        } catch (err) {
          text = `Error: ${(err as Error).message}`;
          record.toolCalls.push({ name: call.name, args: '(not shown)', ok: false, durationMs: 0, preview: run.scrub(text).slice(0, 300) });
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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeArgs(args: Record<string, unknown>): string {
  // no typed text or keys: those are shown as [REDACTED] in logs when they are secret
  const pick = args.url ?? args.query ?? args.ref ?? args.selector ?? args.name;
  if (typeof pick !== 'string') return '';
  return pick.length > 80 ? `${pick.slice(0, 77)}...` : pick;
}
