import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { SERIALIZE_VALUE } from '../browser/scripts.ts';
import { describeException, type RemoteObject, type Tab } from '../browser/tab.ts';
import { CdpError, CdpTimeoutError } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import type { ConsoleEntry, NetworkEntry } from '../dashboard/hub.ts';
import { navigationNote } from './interaction.ts';
import { compactJson, truncate } from './format.ts';
import { ACTION, READ_ONLY, defineTool, textResult } from './types.ts';

const RESULT_LIMIT = 20_000;
/** JSON size budget for object results; compact formatting adds indentation, so it stays well below RESULT_LIMIT. */
const SERIALIZE_LIMIT = 12_000;
/** Time kept free below TOOL_TIMEOUT_MS so evaluate ends with its own error (and releases the queue only once Obscura is done). */
const TOOL_TIMEOUT_RESERVE_MS = 3_000;

// ------------------------------------------------------------------ evaluate helpers

/** Parses `body` as an (async) function body without running it; returns the SyntaxError message or null. */
const CHECK_BODY = `function checkBody(body, isAsync) {
  try { var Ctor = isAsync ? Object.getPrototypeOf(async function () {}).constructor : Function; Ctor(body); return null; }
  catch (e) { return String((e && e.message) || e); }
}`;

const STATEMENT_START =
  /^(?:var|let|const|if|for|while|do|switch|try|throw|return|function|class|import|export|break|continue|debugger|with)\b|^async\s+function\b|^\{/;
const CONTINUES_BEFORE = /[+\-*/%=&|^!~?:.,<>([{]$/;
const CONTINUES_AFTER = /^(?:[.([`+\-*/%=&|^?:,<>]|instanceof\b|in\b)/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|delete|new|throw|yield|await|instanceof)$/;

/**
 * Offsets that split `src` into top-level statements: after `;` or at line
 * breaks outside brackets, strings, template literals, comments and regex
 * literals, skipping line breaks where the expression obviously continues.
 * A heuristic; every candidate built from it is syntax-checked before use.
 */
export function statementBoundaries(src: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let prev = ''; // last significant character outside comments/strings
  let i = 0;
  const n = src.length;

  const skipString = (quote: string, from: number): number => {
    let j = from + 1;
    while (j < n && src[j] !== quote) {
      if (src[j] === '\\') j++;
      else if (src[j] === '\n' && quote !== '`') break;
      j++;
    }
    return j + 1;
  };
  const skipTemplate = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') j += 2;
      else if (ch === '`') return j + 1;
      else if (ch === '$' && src[j + 1] === '{') {
        let d = 1;
        j += 2;
        while (j < n && d > 0) {
          const c = src[j];
          if (c === '{') d++;
          else if (c === '}') d--;
          else if (c === "'" || c === '"') {
            j = skipString(c, j);
            continue;
          } else if (c === '`') {
            j = skipTemplate(j);
            continue;
          }
          j++;
        }
      } else j++;
    }
    return j;
  };
  const skipRegex = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    while (j < n && src[j] !== '\n') {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(src[j]!)) j++;
        return j;
      }
      j++;
    }
    return j;
  };
  const nextSignificant = (from: number): string => {
    let j = from;
    for (;;) {
      while (j < n && /\s/.test(src[j]!)) j++;
      if (src.startsWith('//', j)) {
        while (j < n && src[j] !== '\n') j++;
        continue;
      }
      if (src.startsWith('/*', j)) {
        const end = src.indexOf('*/', j + 2);
        j = end < 0 ? n : end + 2;
        continue;
      }
      return src.slice(j, j + 12);
    }
  };

  while (i < n) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(ch, i);
      prev = 'a';
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(i);
      prev = 'a';
      continue;
    }
    if (ch === '/') {
      const before = src.slice(Math.max(0, i - 12), i).trimEnd();
      const last = before.slice(-1);
      const isRegex = before === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || REGEX_AFTER_WORD.test(before);
      if (isRegex) {
        i = skipRegex(i);
        prev = 'a';
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ';') out.push(i + 1);
    else if (depth === 0 && ch === '\n') {
      const next = nextSignificant(i + 1);
      if (!CONTINUES_BEFORE.test(prev) && !CONTINUES_AFTER.test(next) && next !== '') out.push(i + 1);
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}

/**
 * Code like `{a: 1, b: 2}` is meant as an object literal (as in a devtools
 * console), but a script parses it as a block. Returns the parenthesized
 * form to try when the code is wrapped in braces; it is used only if it parses.
 */
export function objectLiteralCandidate(src: string): string | null {
  const trimmed = src.trim().replace(/;+$/, '').trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? `(\n${trimmed}\n)` : null;
}

/** Build async-function bodies for code that uses top-level await/return, most specific first. */
export function asyncBodyCandidates(src: string): string[] {
  const trimmed = src.trim().replace(/;+\s*$/, '');
  const candidates: string[] = [];
  if (!STATEMENT_START.test(trimmed)) candidates.push(`return (\n${trimmed}\n);`);
  const bounds = statementBoundaries(src);
  for (let k = bounds.length - 1; k >= 0; k--) {
    const pos = bounds[k]!;
    const tail = src.slice(pos).trim().replace(/;+\s*$/, '');
    if (!tail) continue;
    if (STATEMENT_START.test(tail)) break;
    const head = src.slice(0, pos);
    candidates.push(`${head}\nreturn (\n${tail}\n);`);
    break;
  }
  candidates.push(src);
  return candidates;
}

/**
 * True when the evaluated code failed to parse, so none of it ran and it is
 * safe to retry in another form. V8's message depends on where `await` sits
 * ("await is only valid…", "Unexpected identifier", "missing ) after argument
 * list"), so the stack is used instead: a parse error carries only Obscura's
 * wrapper frames, while an error thrown by code that ran (JSON.parse, a nested
 * eval) has an `eval at` frame from the evaluated code.
 */
async function isParseError(tab: Tab, code: string, ex: RemoteObject | undefined): Promise<boolean> {
  if (!ex || ex.className !== 'SyntaxError') return false;
  const desc = ex.description ?? '';
  if (/eval at /.test(desc)) return false;
  if (/\n\s+at /.test(desc)) return true;
  // no stack frames (the page lowered Error.stackTraceLimit): certain only if the code does not even parse as a function body
  return (await tab.callFunction<string | null>(CHECK_BODY, [code, false])) !== null;
}

function cleanError(details: any): string {
  return describeException(details)
    .split('\n')
    .filter((line, idx) => idx === 0 || !/<anonymous>|<obscura:|ext:core\//.test(line))
    .join('\n')
    .trim();
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

interface EvalOutcome {
  result: RemoteObject;
  exceptionDetails?: any;
}

/**
 * Runtime.evaluate bounded by the requested timeout. Obscura's per-command JS
 * watchdog (OBSCURA_JS_WATCHDOG_MS) terminates any evaluation that runs
 * longer, including pending timers of an awaited promise, and the whole tool
 * call must end before TOOL_TIMEOUT_MS (otherwise the generic tool timeout
 * fires and the next queued call starts while Obscura is still busy), so the
 * effective limit is the smallest of the three. Obscura's own `timeout` only
 * bounds promise waits; synchronous code (an endless loop) ignores it, so the
 * client-side command timeout returns control to the agent while the watchdog
 * frees the browser later.
 */
async function runEvaluate(tab: Tab, expression: string, awaitPromise: boolean, requestedMs: number, config: Config): Promise<EvalOutcome> {
  const watchdogMs = config.obscura.jsWatchdogMs;
  const toolTimeoutMs = config.browser.toolTimeoutMs;
  const toolMaxMs = Math.max(100, toolTimeoutMs - TOOL_TIMEOUT_RESERVE_MS);
  const limitedByWatchdog = watchdogMs > 0 && watchdogMs < requestedMs && watchdogMs <= toolMaxMs;
  const limitedByTool = !limitedByWatchdog && toolMaxMs < requestedMs;
  const effectiveMs = limitedByWatchdog ? watchdogMs : limitedByTool ? toolMaxMs : requestedMs;
  const toolLimit = `the server's tool time limit (TOOL_TIMEOUT_MS=${toolTimeoutMs}) allows at most ${formatSeconds(toolMaxMs)} per script`;
  const watchdog = `Obscura's JS watchdog (OBSCURA_JS_WATCHDOG_MS=${watchdogMs})`;
  const watchdogError = () =>
    new ToolError(
      `JavaScript was terminated by Obscura's JS watchdog after ${formatSeconds(watchdogMs)} (OBSCURA_JS_WATCHDOG_MS=${watchdogMs}) before it finished` +
        `${limitedByWatchdog ? `; the watchdog limit is shorter than the requested ${formatSeconds(requestedMs)} timeout` : ''}. ` +
        'Avoid long-running scripts or split the work into smaller calls (the limit can be raised with OBSCURA_JS_WATCHDOG_MS).',
    );
  try {
    return await tab.send<EvalOutcome>(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: false, userGesture: true, timeout: effectiveMs },
      effectiveMs + 2_000,
    );
  } catch (err) {
    if (err instanceof CdpTimeoutError) {
      throw new ToolError(
        `JavaScript did not finish within ${formatSeconds(effectiveMs)} (timeout${limitedByTool ? `; ${toolLimit}` : ''}). ` +
          'The script is probably stuck in synchronous code such as an endless loop, which cannot be interrupted' +
          (watchdogMs > 0
            ? `: ${watchdog} stops it after ${formatSeconds(watchdogMs)}, and the browser stays busy until then.`
            : ' and runs until it ends because the JS watchdog is disabled (OBSCURA_JS_WATCHDOG_MS=0).'),
      );
    }
    if (err instanceof CdpError) {
      if (/execution terminated/i.test(err.message)) throw watchdogError();
      if (/did not settle within|exceeded \d+ ?ms timeout/i.test(err.message)) {
        if (limitedByWatchdog) throw watchdogError();
        const maxMs = Math.min(120_000, toolMaxMs, watchdogMs > 0 ? watchdogMs : Infinity);
        let advice: string;
        if (effectiveMs < maxMs) advice = `Pass a larger timeout (up to ${formatSeconds(maxMs)}) if it needs longer.`;
        else if (limitedByTool || toolMaxMs <= effectiveMs) advice = `Scripts cannot run longer: ${toolLimit}.`;
        else advice = `Scripts cannot run longer than ${watchdogMs > 0 && watchdogMs <= 120_000 ? watchdog : 'the 120 s maximum timeout'} allows.`;
        throw new ToolError(`JavaScript did not finish within ${formatSeconds(effectiveMs)} (timeout): a promise was still pending. ${advice}`);
      }
      throw new ToolError(`JavaScript evaluation failed: ${err.message}`);
    }
    throw err;
  }
}

/** Turn SERIALIZE_VALUE markers into readable JSON values. */
function readable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(readable);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.__type === 'string') {
    switch (o.__type) {
      case 'undefined':
        return 'undefined';
      case 'circular':
        return '[Circular]';
      case 'truncated':
        return o.value ? `[${o.value}]` : '[Truncated]';
      case 'Map':
        return readable(o.value);
      case 'Set':
        return readable(o.value);
      case 'document':
        return `#document ${o.value}`;
      case 'bigint':
        return `${o.value}n`;
      case 'error':
        return cleanStack(String(o.value));
      default:
        return o.value ?? `[${o.__type}]`;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) out[k] = readable(val);
  return out;
}

function formatNumber(obj: RemoteObject): string {
  const raw = obj.unserializableValue ?? (typeof obj.value === 'number' ? obj.value : obj.value !== undefined && obj.value !== '' ? obj.value : obj.description);
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw === 'string' && !Number.isFinite(num)) return raw.replace(/\.0$/, '');
  if (Object.is(num, -0)) return '-0';
  return String(num);
}

/** Error text for a thrown value; plain objects (`throw {code: 1}`) are shown as JSON instead of "Object". */
async function describeThrown(tab: Tab, details: any, docChanged: boolean): Promise<string> {
  const text = cleanError(details);
  const ex = details?.exception as RemoteObject | undefined;
  if (!ex?.objectId || ex.type !== 'object' || ex.subtype === 'error' || /\n\s+at /.test(ex.description ?? '') || docChanged) return text;
  try {
    const json = await tab.callFunction<string>(SERIALIZE_VALUE, [2_000], { objectId: ex.objectId });
    const shown = readable(JSON.parse(json));
    return truncate(typeof shown === 'string' ? shown : (JSON.stringify(shown) ?? text), 2_000);
  } catch {
    return text;
  }
}

async function formatResult(tab: Tab, obj: RemoteObject, docChanged: boolean): Promise<string> {
  switch (obj.type) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return typeof obj.value === 'string' ? obj.value : (obj.description ?? '');
    case 'number':
      return formatNumber(obj);
    case 'boolean':
      return String(obj.value === true || obj.value === 'true' || obj.description === 'true');
    case 'bigint': {
      const text = obj.unserializableValue ?? obj.description ?? String(obj.value);
      return text.endsWith('n') ? text : `${text}n`;
    }
    case 'symbol':
      return obj.description ?? String(obj.value);
    case 'function':
      return obj.description ?? 'function';
    default:
      break;
  }
  if (obj.subtype === 'null') return 'null';
  if (obj.className === 'Promise' || obj.subtype === 'promise') return 'Promise (not awaited; set await_promise to true to get its value)';
  if (!obj.objectId) return obj.value !== undefined ? compactJson(obj.value) : (obj.description ?? obj.type);
  const unavailable = `${obj.description ?? obj.className ?? 'object'} (the page navigated, so the value is no longer available)`;
  if (docChanged) return unavailable;
  let json: string;
  try {
    json = await tab.callFunction<string>(SERIALIZE_VALUE, [SERIALIZE_LIMIT], { objectId: obj.objectId });
  } catch {
    return obj.description ?? obj.className ?? 'object';
  }
  if (docChanged) return unavailable;
  if (typeof json !== 'string') return obj.description ?? 'object';
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json; // truncated JSON
  }
  const shown = readable(value);
  if (typeof shown === 'string') return shown;
  const text = compactJson(shown);
  // one-line JSON when indentation would push a large value past the output limit, so it stays valid JSON
  return text.length > RESULT_LIMIT ? (JSON.stringify(shown) ?? text) : text;
}

/** Obscura keeps every evaluation result alive until it is released. */
function releaseObject(tab: Tab, objectId: string | undefined): void {
  if (objectId) void tab.send('Runtime.releaseObject', { objectId }, 5_000, true).catch(() => undefined);
}

/**
 * performance.timeOrigin identifies the JS realm: it changes when a new document loads but not on
 * history.pushState/replaceState (which Obscura otherwise reports as a navigation). Comparing it
 * before and after the code decides whether the result's objectId still belongs to the live document.
 */
async function readTimeOrigin(tab: Tab): Promise<number | null> {
  return tab.callFunction<number>(`function readTimeOrigin() { return (typeof performance !== 'undefined' && performance.timeOrigin) || 0; }`).catch(() => null);
}

/** Call a function value (e.g. the result of evaluating `() => document.title`) and return its outcome. */
async function callFunctionValue(tab: Tab, objectId: string, timeoutMs: number): Promise<EvalOutcome> {
  return tab.send<EvalOutcome>(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: 'function () { return this(); }', awaitPromise: true, returnByValue: false, userGesture: true, timeout: timeoutMs },
    timeoutMs + 5_000,
  );
}

// ------------------------------------------------------------------ tools

export const evaluate = defineTool({
  name: 'browser_evaluate',
  title: 'Run JavaScript',
  group: 'debug',
  description:
    'Run JavaScript in the active page and return the result. Accepts an expression (`document.title`), an object literal ' +
    '(`{title: document.title, links: document.links.length}`), statements (the last expression is the result: `const n = 2; n * 21`) ' +
    'and top-level await (`await fetch("/api").then(r => r.json())`); returned promises are awaited. ' +
    'Objects and arrays come back as JSON (large values are shortened), DOM elements as their HTML. Thrown errors are reported as errors. ' +
    'Prefer browser_snapshot / browser_extract for reading pages; use this for custom checks or page APIs.',
  inputSchema: z.object({
    expression: z.string().describe('JavaScript code to run in the page'),
    await_promise: z.boolean().optional().describe('Wait for a returned Promise and return its value (default true; code using top-level await is always awaited)'),
    timeout: z
      .number()
      .min(0.1)
      .max(120)
      .optional()
      .describe('Maximum run time in seconds (default 30, max 120; also capped by the server\'s JS watchdog and tool time limits)'),
  }),
  annotations: { ...ACTION, title: 'Run JavaScript' },
  handler: async ({ expression, await_promise, timeout }, ctx) => {
    if (!expression.trim()) throw new ToolError('expression must not be empty');
    const tab = await ctx.tab();
    // refuse to run in a document that navigated itself to a blocked scheme (file:, javascript:)
    await tab.guardDocument();
    const timeoutMs = Math.round((timeout ?? 30) * 1000);
    const awaitPromise = await_promise ?? true;

    const outcome = await tab.trackNavigation(async () => {
      const originBefore = await readTimeOrigin(tab);
      let code = expression;
      const literal = objectLiteralCandidate(expression);
      // parse-only check (as an async body, so `{a: await x}` qualifies too); nothing runs here
      if (literal && (await tab.callFunction<string | null>(CHECK_BODY, [`return ${literal};`, true])) === null) code = literal;
      let res = await runEvaluate(tab, code, awaitPromise, timeoutMs, ctx.config);
      if (
        res.exceptionDetails &&
        /\b(?:await|return)\b/.test(code) &&
        (await isParseError(tab, code, res.exceptionDetails.exception ?? res.result))
      ) {
        // Top-level await/return: Obscura evaluates scripts, so run the code as an async function body.
        releaseObject(tab, res.result?.objectId);
        if (res.exceptionDetails.exception?.objectId !== res.result?.objectId) releaseObject(tab, res.exceptionDetails.exception?.objectId);
        let body: string | null = null;
        let lastError: string | null = null;
        for (const candidate of asyncBodyCandidates(code)) {
          lastError = await tab.callFunction<string | null>(CHECK_BODY, [candidate, true]);
          if (lastError === null) {
            body = candidate;
            break;
          }
        }
        // the last candidate is the code as written, so its parse error is the meaningful one
        if (body === null) throw new ToolError(`JavaScript error: SyntaxError: ${lastError ?? 'invalid code'}`);
        res = await runEvaluate(tab, `(async () => {\n${body}\n})()`, true, timeoutMs, ctx.config);
      }
      // an arrow/function expression ("() => document.title") evaluates to a function; call it and
      // return its value instead of the useless "function () {…}" string
      if (!res.exceptionDetails && res.result?.type === 'function' && res.result.objectId) {
        const called = await callFunctionValue(tab, res.result.objectId, timeoutMs).catch(() => null);
        if (called) {
          releaseObject(tab, res.result.objectId);
          res = called;
        }
      }
      // Decide whether the value is still available by document identity, not navSeq: history.pushState
      // bumps navSeq but keeps the same document, so the result's objectId is still valid and returnable.
      const originAfter = await readTimeOrigin(tab);
      const docChanged = originBefore === null || originAfter === null || originAfter !== originBefore;
      try {
        if (res.exceptionDetails) throw new ToolError(`JavaScript error: ${await describeThrown(tab, res.exceptionDetails, docChanged)}`);
        return await formatResult(tab, res.result, docChanged);
      } finally {
        if (!docChanged) {
          releaseObject(tab, res.result?.objectId);
          if (res.exceptionDetails?.exception?.objectId !== res.result?.objectId) releaseObject(tab, res.exceptionDetails?.exception?.objectId);
        }
      }
    });
    return textResult(truncate(outcome.result, RESULT_LIMIT) + navigationNote(outcome));
  },
});

// ------------------------------------------------------------------ console

const LEVELS: Record<string, string[]> = {
  error: ['error', 'exception', 'assert'],
  warn: ['warn'],
  info: ['info'],
  log: ['log', 'trace', 'dir', 'table'],
  debug: ['debug'],
};

function cleanStack(text: string): string {
  return text
    .split('\n')
    .filter((line, idx) => idx === 0 || !/<obscura:|ext:core\/|<eval-remote>|at eval \(<anonymous>\)/.test(line))
    .join('\n');
}

/** The newest lines (input is oldest first) whose total length fits in `budget` characters. */
function newestThatFit(lines: string[], budget: number): string[] {
  let used = 0;
  let start = lines.length;
  while (start > 0 && used + lines[start - 1]!.length + 1 <= budget) {
    used += lines[start - 1]!.length + 1;
    start--;
  }
  if (start === lines.length && lines.length > 0) return [truncate(lines[lines.length - 1]!, budget)];
  return lines.slice(start);
}

/** "Showing the last N of M <noun>." when not everything matching is shown. */
function listingHeader(shown: number, limited: number, matching: number, noun: string): string {
  if (shown >= matching) return '';
  const omitted = shown < limited ? ' (older ones omitted to keep the output short; narrow with limit or filters)' : '';
  return `Showing the last ${shown} of ${matching} ${noun}${omitted}.\n`;
}

function formatConsole(entry: ConsoleEntry): string {
  let text = cleanStack(entry.text);
  if (text.length > 2000) text = truncate(text, 2000);
  const source = entry.level === 'exception' && entry.url && !text.includes(entry.url) ? ` (${entry.url})` : '';
  return `[${entry.level}] ${text}${source}`;
}

export const consoleMessages = defineTool({
  name: 'browser_console_messages',
  title: 'Console messages',
  group: 'debug',
  description:
    'Show console output and uncaught errors of the active tab (console.log/warn/error, script exceptions), oldest first. ' +
    'Messages are kept across navigations in the tab. Use level "error" to see only errors and exceptions.',
  inputSchema: z.object({
    level: z.enum(['all', 'error', 'warn', 'info', 'log', 'debug']).optional().describe('Only messages of this level (default "all"; "error" includes uncaught exceptions)'),
    limit: z.number().int().min(1).max(1000).optional().describe('Show at most this many of the most recent messages (default 100)'),
    clear: z.boolean().optional().describe('After returning the messages, delete all stored messages of this tab (every level, including ones not shown)'),
  }),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'Console messages' },
  handler: async ({ level, limit, clear }, ctx) => {
    const tab = ctx.browser.activeTab;
    const all = tab && !tab.closed ? [...tab.consoleEntries] : [];
    if (clear && tab) tab.clearConsole();
    const wanted = level && level !== 'all' ? LEVELS[level]! : null;
    const matching = wanted ? all.filter((e) => wanted.includes(e.level)) : all;
    const suffix = clear && all.length ? `\n(${all.length} message(s) cleared)` : '';
    if (matching.length === 0) {
      return textResult(`${all.length && wanted ? `No ${level} console messages (${all.length} of other levels).` : 'No console messages.'}${suffix}`);
    }
    const recent = matching.slice(-(limit ?? 100));
    const lines = newestThatFit(recent.map(formatConsole), RESULT_LIMIT - 200);
    return textResult(listingHeader(lines.length, recent.length, matching.length, 'messages') + lines.join('\n') + suffix);
  },
});

// ------------------------------------------------------------------ network

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRequest(e: NetworkEntry): string {
  const status = e.state === 'pending' && e.status === null ? 'pending' : String(e.status ?? '?');
  const url = e.url.length > 300 ? `${e.url.slice(0, 300)}…` : e.url;
  const details = [e.resourceType, formatSize(e.size), e.durationMs !== null ? `${e.durationMs} ms` : null].filter(Boolean);
  return `[${status}] ${e.method} ${url} (${details.join(', ')})`;
}

export const networkRequests = defineTool({
  name: 'browser_network_requests',
  title: 'Network requests',
  group: 'debug',
  description:
    'List the network requests of the page currently open in the active tab (document, scripts, stylesheets, images, fetch/XHR), ' +
    'with HTTP status, type, size and duration. The list starts over on each navigation. ' +
    'Note: with Obscura stealth mode on, requests made by page scripts (fetch/XHR) are not reported.',
  inputSchema: z.object({
    filter: z.string().optional().describe('Only requests whose URL contains this text (case-insensitive)'),
    resource_type: z.string().optional().describe('Only this resource type: Document, Script, Stylesheet, Image, Font, Fetch, XHR, Other'),
    limit: z.number().int().min(1).max(500).optional().describe('Show at most this many of the most recent requests (default 100)'),
    failed_only: z.boolean().optional().describe('Only requests that failed with HTTP status 400 or higher'),
  }),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'Network requests' },
  handler: async ({ filter, resource_type, limit, failed_only }, ctx) => {
    const tab = ctx.browser.activeTab;
    const all = tab && !tab.closed ? tab.networkEntries() : [];
    if (all.length === 0) return textResult('No network requests recorded for the current page.');
    const needle = filter?.trim().toLowerCase();
    const type = resource_type?.trim().toLowerCase();
    const matching = all.filter(
      (e) =>
        (!needle || e.url.toLowerCase().includes(needle)) &&
        (!type || e.resourceType.toLowerCase() === type) &&
        (!failed_only || (e.status !== null && e.status >= 400)),
    );
    const scriptTypes = new Set(['fetch', 'xhr']);
    const stealthNote =
      ctx.config.obscura.stealth && !all.some((e) => scriptTypes.has(e.resourceType.toLowerCase())) && (!type || scriptTypes.has(type))
        ? '\n(Obscura stealth mode is on: fetch/XHR requests made by page scripts are not reported.)'
        : '';
    if (matching.length === 0) {
      return textResult(`No network requests match the filters (${all.length} recorded for the current page).${stealthNote}`);
    }
    const recent = matching.slice(-(limit ?? 100));
    const lines = newestThatFit(recent.map(formatRequest), RESULT_LIMIT - 300);
    return textResult(listingHeader(lines.length, recent.length, matching.length, 'requests') + lines.join('\n') + stealthNote);
  },
});

export default [evaluate, consoleMessages, networkRequests];
