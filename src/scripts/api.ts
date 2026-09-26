import vm from 'node:vm';
import * as z from 'zod';
import type { Browser } from '../browser/browser.ts';
import { ToolError } from '../browser/errors.ts';
import { EXTRACT_TEXT } from '../browser/scripts.ts';
import { runTool, type McpDeps } from '../mcp/server.ts';
import type { RemoteObject } from '../browser/tab.ts';
import { asyncBodyCandidates } from '../tools/debug.ts';
import { ALL_TOOLS } from '../tools/index.ts';
import { clickElement } from '../tools/interaction.ts';
import { READ_ONLY, defineTool, textResult, type ToolDefinition } from '../tools/types.ts';
import type { SandboxHost } from './sandbox.ts';

/**
 * The `browser` object scripts use. Each method is one call of the regular browser tools (so it
 * is logged, shown on the dashboard and subject to the same URL and network guards), returning
 * plain values instead of tool text.
 */
export const SCRIPT_METHODS = [
  'goto',
  'back',
  'forward',
  'reload',
  'url',
  'title',
  'click',
  'clickText',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'scroll',
  'waitFor',
  'waitForText',
  'wait',
  'sleep',
  'text',
  'markdown',
  'snapshot',
  'links',
  'extract',
  'evaluate',
  'count',
  'exists',
  'attr',
] as const;

/** Reference for script authors (shown to the automation agent and by script_get). */
export const SCRIPT_API_DOC = `Scripts are plain JavaScript (no imports, no Node.js APIs, no fetch/require). Define:

  async function run(params) {
    // params: the declared parameters, already validated and defaulted
    await browser.goto('https://example.com/search?q=' + encodeURIComponent(params.query));
    await browser.waitFor('.result');
    const items = await browser.extract({ 'titles[]': '.result h2', 'links[]': '.result a@href' });
    log('found', items.titles.length);
    return items.titles.slice(0, params.limit).map((t, i) => ({ title: t, url: items.links[i] }));
  }

The return value (JSON-serializable) is the script's output. Throw an Error to fail the run.
"target" is a CSS selector string (use stable selectors: ids, names, aria/data attributes, not generated class names).
Every browser method returns a Promise: always await it.

  browser.goto(url, {waitUntil?: 'load'|'domcontentloaded'|'networkidle0'}) -> {url, title, status}
  browser.back() / browser.forward() / browser.reload() -> {url, title}
  browser.url() -> string            browser.title() -> string
  browser.click(target) -> string    browser.clickText(text, {exact?: false, index?: 0}) -> string  (clicks a link/button/element by its visible text)
  browser.fill(target, value) -> string          (replace a field's value)
  browser.type(target, text, {submit?: false}) -> string   (append text; submit presses Enter)
  browser.press(key, target?) -> string          (Enter, Tab, Escape, ArrowDown, ...)
  browser.select(target, valueOrLabel | [values]) -> string
  browser.check(target, checked = true) -> string
  browser.scroll('down'|'up'|'top'|'bottom' | target, amountPx?) -> string
  browser.waitFor(selector, {state?: 'visible'|'attached'|'hidden'|'detached', timeout?: seconds}) -> true (throws on timeout)
  browser.waitForText(text, {gone?: false, timeout?: seconds}) -> true (throws on timeout)
  browser.wait(seconds) / sleep(ms)
  browser.text(target?) -> string                (visible text of an element, or of the whole page)
  browser.markdown({selector?}) -> string        (page or element as Markdown)
  browser.snapshot() -> string                   (page text plus interactive elements)
  browser.links({filter?, internalOnly?, limit?}) -> [{text, href}]
  browser.extract(schema) -> object              ({"title": "h1", "prices[]": ".price", "links[]": "a.item@href"}; [] = all matches, @attr = attribute)
  browser.evaluate(codeOrFunction, ...args) -> value  (runs in the page: an expression, statements (the last value is the result), a function body with return, or a function)
  browser.count(selector) -> number              browser.exists(selector) -> boolean
  browser.attr(target, name) -> string | null    (href/src come back absolute)
  log(...values)                                 (recorded in the run's log)`;

const ACTIONS = new Set(['click', 'clickText', 'fill', 'type', 'press', 'select', 'check', 'scroll']);

/** Whether `source` compiles (compiles only; runs nothing). */
function compiles(source: string): boolean {
  try {
    new vm.Script(source);
    return true;
  } catch {
    return false;
  }
}

/** Whether `code` parses as an expression (else it is run as statements or a function body). */
export function isExpression(code: string): boolean {
  return compiles(`(async () => { return (${code}\n); })`);
}

/** A line starting like this continues the statement above it (`++`/`--` start a new one). */
const CONTINUES_LINE = /^(?![+-]{2})[([`+\-*/%.,?:=<>&|^]/;

/**
 * `code` as an async function body whose last statement is returned, when that last statement is an
 * expression: tries the last statement boundaries (`;` or a line break, from the end) and keeps the
 * first split the parser accepts. Only for code of reasonable size (each try is a parse); null otherwise.
 */
function lastExpressionAsReturn(code: string): string | null {
  if (code.length > 50_000) return null;
  let tries = 0;
  for (let p = code.length - 1; p >= 0 && tries < 200; p--) {
    const ch = code[p];
    if (ch !== ';' && ch !== '\n' && ch !== '\r' && ch !== '\u2028' && ch !== '\u2029') continue;
    const tail = code.slice(p + 1).trim().replace(/;+\s*$/, '');
    if (!tail || (ch !== ';' && CONTINUES_LINE.test(tail))) continue;
    tries++;
    if (!isExpression(tail)) continue;
    // `return` goes on the same line: a `;` inside a trailing // comment then keeps it in the comment
    const body = `${code.slice(0, p + 1)} return (\n${tail}\n);`;
    if (compiles(`(async () => {\n${body}\n})`)) return body;
  }
  return null;
}

/**
 * The page-side source that evaluates `code` once and returns its value as JSON: an expression; plain
 * statements (the value of the last one, as in browser_evaluate); or a function body with return or
 * top-level await (the last expression statement becomes the result when there is no return).
 */
export function evaluationSource(code: string): string {
  const toJson = '(__v) => JSON.stringify(__v === undefined ? null : __v)';
  const expr = code.trim().replace(/;+\s*$/, '');
  if (isExpression(expr)) return `(async () => (${toJson})(await (async () => { return (${expr}\n); })()))()`;
  // Plain statements run as a script, which has no top-level await (`await (x)` would even compile as a
  // call). A class static block rejects any real use of `await` but accepts the word in strings,
  // comments, regexes and nested functions, so the parser itself tells whether the code awaits.
  const usesAwait =
    /\bawait\b/.test(code) && compiles(`(async () => {\n${code}\n})`) && !compiles(`(class { static {\n${code}\n} })`);
  if (!usesAwait && compiles(code)) return `(async () => (${toJson})(await (0, eval)(${JSON.stringify(code)})))()`;
  const body = lastExpressionAsReturn(code) ?? asyncBodyCandidates(code).find((c) => compiles(`(async () => {\n${c}\n})`)) ?? code;
  return `(async () => (${toJson})(await (async () => {\n${body}\n})()))()`;
}

/** In-page evaluation with a JSON result (used by evaluate and attr). Runs the code exactly once. */
const scriptEvaluate = defineTool({
  name: 'script_evaluate',
  title: 'Run JavaScript (script)',
  group: 'scripts',
  description: 'Evaluate JavaScript in the page for a script and return its value as JSON.',
  inputSchema: z.object({ code: z.string().min(1) }),
  annotations: READ_ONLY,
  handler: async ({ code }, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    const res = await tab.evaluate(evaluationSource(code), { awaitPromise: true, returnByValue: true });
    return textResult(typeof res.value === 'string' ? res.value : 'null');
  },
});

/** Visible text of the whole page for a script (logged like any other call; refuses file: documents). */
const scriptPageText = defineTool({
  name: 'script_page_text',
  title: 'Read page text (script)',
  group: 'scripts',
  description: 'Return the visible text of the current page for a script.',
  inputSchema: z.object({}),
  annotations: READ_ONLY,
  handler: async (_args, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    return textResult((await tab.callFunction<string | null>(EXTRACT_TEXT, [null])) ?? '');
  },
});

/** Click the element with the given visible text, like browser_click (refuses file: documents; writes nothing into the page). */
const scriptClickText = defineTool({
  name: 'script_click_text',
  title: 'Click element by text (script)',
  group: 'scripts',
  description: 'Click the link, button or other clickable element with the given visible text.',
  inputSchema: z.object({ text: z.string(), exact: z.boolean(), index: z.number().int().min(0) }),
  annotations: READ_ONLY,
  handler: async ({ text, exact, index }, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    const found = await tab.callFunction<RemoteObject>(FIND_BY_TEXT, [text, exact, index], { returnByValue: false });
    // Obscura returns null as an object with subtype "null" (and an objectId)
    if (!found?.objectId || found.subtype === 'null') {
      if (found?.objectId) await tab.send('Runtime.releaseObject', { objectId: found.objectId }).catch(() => undefined);
      throw new ToolError(`no clickable element with text ${JSON.stringify(text)}${index ? ` at index ${index}` : ''}`);
    }
    const { outcome } = await clickElement(ctx, tab, { objectId: found.objectId, target: `text ${JSON.stringify(text)}` });
    return textResult(`Clicked the element with text ${JSON.stringify(text)}${outcome.urlChanged ? `; now on ${outcome.info.url}` : ''}`);
  },
});

const FIND_BY_TEXT = `function findByText(text, exact, index) {
  function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
  var want = norm(text);
  var candidates = document.querySelectorAll('a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label, [onclick]');
  var hits = [];
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    var label = norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
    if (!label) continue;
    if (exact ? label === want : label.indexOf(want) >= 0) {
      var r = el.getBoundingClientRect();
      hits.push({ el: el, visible: r.width > 0 && r.height > 0, len: label.length });
    }
  }
  hits.sort(function (a, b) { return (b.visible - a.visible) || (a.len - b.len); });
  var hit = hits[index || 0];
  return hit ? hit.el : null;
}`;

function findTool(name: string): ToolDefinition<any> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`internal: unknown tool ${name}`);
  return tool;
}

function target(value: unknown, what = 'target'): { selector?: string; ref?: string } {
  if (typeof value === 'string' && value.trim()) return { selector: value };
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.selector === 'string') return { selector: v.selector };
    if (typeof v.ref === 'string') return { ref: v.ref };
  }
  throw new Error(`${what} must be a CSS selector string`);
}

function opt(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export interface ScriptHostOptions {
  deps: McpDeps;
  browser: Browser;
  /** Label for logs and the dashboard, e.g. "script:hn-top". */
  client: string;
  agentRunId?: string;
  onLog: (line: string) => void;
  /** Called after each browser call (for progress reporting). */
  onCall?: (method: string) => void;
  /** Aborted when the run ends: calls still waiting for the browser are skipped. */
  signal?: AbortSignal;
}

/** Tool texts that mean "nothing there" rather than content. */
const NO_TEXT = /^Element .* has no text\.$/;
const NO_CONTENT = /^\((?:page|element .*) has no readable content\)$/;

export function createScriptHost(opts: ScriptHostOptions): SandboxHost {
  const { deps, browser } = opts;

  const resets = browser.resetCount;
  const checkAlive = () => {
    if (opts.signal?.aborted) throw new Error('the script run has ended');
    if (browser.resetCount !== resets) throw new Error('the browser engine restarted during the script; its pages and cookies were lost');
  };
  const invoke = async (tool: ToolDefinition<any>, args: Record<string, unknown>): Promise<string> => {
    checkAlive();
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(`invalid arguments for ${tool.name}: ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
    }
    const result = await runTool(tool, parsed.data, null, deps, { browser, client: opts.client, agentRunId: opts.agentRunId, signal: opts.signal });
    if (browser.resetCount !== resets) throw new Error('the browser engine restarted during the script; its pages and cookies were lost');
    const text = (result.content ?? []).map((c: any) => (c.type === 'text' ? c.text : '')).join('\n');
    if (result.isError) throw new Error(text.replace(/^Error:\s*/, ''));
    return text;
  };
  const call = (name: string, args: Record<string, unknown>) => invoke(findTool(name), args);
  const pageState = () =>
    browser.mutex.run(async () => {
      checkAlive();
      const tab = await browser.ensureActiveTab();
      const info = await tab.pageInfo();
      checkAlive();
      return { url: info?.url ?? tab.url, title: info?.title ?? tab.title };
    });
  const evaluateJson = async (code: string): Promise<unknown> => {
    const text = await invoke(scriptEvaluate, { code });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
    goto: async (url, options) => {
      const text = await call('browser_navigate', { url: String(url), waitUntil: opt(options).waitUntil });
      // "Navigated to <url> — "<title>" (HTTP 200)": the status ends the first line (the title is JSON-quoted)
      const status = /\(HTTP (\d{3})\)$/.exec(text.split('\n')[0]);
      return { ...(await pageState()), status: status ? Number(status[1]) : null };
    },
    back: async () => (await call('browser_back', {}), pageState()),
    forward: async () => (await call('browser_forward', {}), pageState()),
    reload: async () => (await call('browser_reload', {}), pageState()),
    url: async () => (await pageState()).url,
    title: async () => (await pageState()).title,
    click: (t, options) => call('browser_click', { ...target(t), double_click: opt(options).double ?? undefined }),
    clickText: (text, options) => {
      const o = opt(options);
      return invoke(scriptClickText, { text: String(text), exact: Boolean(o.exact), index: Math.max(0, Math.floor(Number(o.index ?? 0)) || 0) });
    },
    fill: (t, value) => call('browser_fill', { ...target(t), value: value === undefined || value === null ? '' : String(value) }),
    type: (t, text, options) => call('browser_type', { ...target(t), text: String(text ?? ''), submit: opt(options).submit ?? undefined }),
    press: (key, t) => call('browser_press_key', { key: String(key), ...(t === undefined ? {} : target(t)) }),
    select: (t, value) => call('browser_select_option', { ...target(t), ...(Array.isArray(value) ? { values: value.map(String) } : { value: String(value) }) }),
    check: (t, checked) => call('browser_check', { ...target(t), checked: checked === undefined ? true : Boolean(checked) }),
    scroll: (where, amount) =>
      typeof where === 'string' && ['top', 'bottom', 'up', 'down', 'left', 'right'].includes(where)
        ? call('browser_scroll', { direction: where, amount: typeof amount === 'number' ? amount : undefined })
        : call('browser_scroll', where === undefined ? {} : target(where)),
    waitFor: async (selector, options) => {
      const o = opt(options);
      await call('browser_wait_for', { selector: String(selector), state: o.state, timeout: o.timeout });
      return true;
    },
    waitForText: async (text, options) => {
      const o = opt(options);
      await call('browser_wait_for_text', { text: String(text), gone: o.gone, timeout: o.timeout });
      return true;
    },
    wait: (seconds) => call('browser_wait', { seconds: Math.min(30, Math.max(0, Number(seconds) || 0)) }),
    sleep: (ms) => call('browser_wait', { seconds: Math.min(30, Math.max(0, (Number(ms) || 0) / 1000)) }),
    text: async (t) => {
      if (t === undefined || t === null) return invoke(scriptPageText, {});
      const text = await call('browser_get_text', { ...target(t), max_chars: 200_000 });
      return NO_TEXT.test(text) ? '' : text;
    },
    markdown: async (options) => {
      const text = await call('browser_markdown', { selector: opt(options).selector, max_chars: 500_000 });
      return NO_CONTENT.test(text) ? '' : text;
    },
    snapshot: () => call('browser_snapshot', { max_chars: 20_000 }),
    links: async (options) => {
      const o = opt(options);
      const text = await call('browser_links', { filter: o.filter, internal_only: o.internalOnly, limit: Math.min(Number(o.limit ?? 500), 5000) });
      return text
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
    extract: async (schema) => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('extract(schema) needs an object like {"title": "h1"}');
      const text = await call('browser_extract', { schema, max_chars: 500_000 });
      const [json, selectorErrors] = text.split('\nSelector errors:\n');
      if (selectorErrors) throw new Error(selectorErrors.trim());
      try {
        return JSON.parse(json);
      } catch {
        throw new Error(/\(truncated, \d+ more chars\)$/.test(json) ? 'the extracted data is larger than 500000 characters; extract less at once' : `unexpected output: ${json.slice(0, 300)}`);
      }
    },
    evaluate: (code) => evaluateJson(String(code)),
    count: async (selector) => {
      const text = await call('browser_count', { selector: String(selector) });
      return Number(/^(\d+)/.exec(text)?.[1] ?? 0);
    },
    exists: async (selector) => Number(/^(\d+)/.exec(await call('browser_count', { selector: String(selector) }))?.[1] ?? 0) > 0,
    attr: (t, name) => {
      const sel = target(t).selector;
      if (!sel) throw new Error('attr(target, name) needs a CSS selector');
      return evaluateJson(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const n = ${JSON.stringify(String(name))};` +
          ` if ((n === 'href' || n === 'src') && typeof el[n] === 'string' && el[n]) return el[n];` +
          ` if (n === 'value' && 'value' in el) return el.value; if (n === 'checked' && 'checked' in el) return String(el.checked);` +
          ` return el.getAttribute(n); })()`,
      );
    },
  };

  return {
    async call(method, args) {
      const fn = methods[method];
      if (!fn) throw new Error(`browser.${method} is not a function`);
      try {
        const value = await fn(...(Array.isArray(args) ? args : []));
        if (ACTIONS.has(method) && !opts.signal?.aborted) opts.onLog(`[${method}] ${String(value).split('\n')[0].slice(0, 200)}`);
        return value;
      } catch (err) {
        if (err instanceof ToolError || err instanceof Error) throw new Error(`browser.${method}: ${err.message}`);
        throw err;
      } finally {
        if (!opts.signal?.aborted) opts.onCall?.(method);
      }
    },
    // a stopped script's late log lines are dropped
    log: (line) => {
      if (!opts.signal?.aborted) opts.onLog(line);
    },
  };
}
