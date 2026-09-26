import * as z from 'zod';
import { JavaScriptError, ToolError } from '../browser/errors.ts';
import type { Tab } from '../browser/tab.ts';
import { CdpError } from '../cdp/client.ts';
import { READ_ONLY, defineTool, textResult, type ToolContext } from './types.ts';

const MAX_WAIT_SECONDS = 120;

/**
 * Browsers throw for invalid selectors; Obscura's querySelector returns null
 * instead, but CSS.supports('selector(...)') does report them as unsupported.
 */
const SELECTOR_CHECK = `function selectorCheck(selector) {
  var error = null, supported = null;
  try { document.querySelector(selector); } catch (e) { error = String((e && e.message) || e); }
  try { if (typeof CSS !== 'undefined' && CSS.supports) supported = !!CSS.supports('selector(' + selector + ')'); } catch (_e) {}
  return { error: error, supported: supported };
}`;

/**
 * How many elements match and whether the first one is visible. Obscura lays out some visible inline
 * elements with a 0x0 box, so an element (or an ancestor) with a real box counts as visible unless an
 * ancestor is actually hidden by display:none / visibility:hidden / the hidden attribute.
 */
const SELECTOR_STATUS = `function selectorStatus(selector) {
  var els = document.querySelectorAll(selector);
  var visible = false;
  if (els.length) {
    var el = els[0];
    var hasBox = false;
    try {
      for (var b = el, i = 0; b && b.nodeType === 1 && i < 200; b = b.parentNode, i++) {
        var rb = b.getBoundingClientRect();
        if (rb.width > 0 && rb.height > 0) { hasBox = true; break; }
      }
    } catch (_e) {}
    visible = hasBox;
    try {
      for (var n = el, d = 0; visible && n && n.nodeType === 1 && d < 200; n = n.parentNode, d++) {
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') visible = false;
        else if (n.hasAttribute && n.hasAttribute('hidden')) visible = false;
      }
    } catch (_e) {}
  }
  return { count: els.length, visible: visible };
}`;

/**
 * Is `needle` part of the rendered text of the page? document.body.innerText
 * in Obscura includes <script>/<style> contents and hidden elements, so the
 * text is collected here: script-like elements and [hidden] subtrees are
 * skipped, whitespace is collapsed, and every element holding part of a match
 * must have a layout box and no visibility:hidden ancestor. The expensive walk
 * only runs when the raw DOM text contains the needle.
 */
const TEXT_STATE = `function textState(needle) {
  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' '); }
  var want = norm(needle).trim();
  var root = document.body || document.documentElement;
  if (!want || !root) return { visible: false, inDom: false };
  var raw = norm(root.textContent);
  if (raw.indexOf(want) < 0 && raw.replace(/ /g, '').indexOf(want.replace(/ /g, '')) < 0) return { visible: false, inDom: false };

  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, title: 1 };
  var BLOCK = { address: 1, article: 1, aside: 1, blockquote: 1, br: 1, dd: 1, details: 1, dialog: 1, div: 1, dl: 1, dt: 1, fieldset: 1,
    figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, li: 1, main: 1, nav: 1,
    ol: 1, p: 1, pre: 1, section: 1, summary: 1, table: 1, td: 1, th: 1, tr: 1, ul: 1 };
  var text = '', parts = [], BREAK = {}, stack = [root], visited = 0;
  function space() { if (text.length && text.charAt(text.length - 1) !== ' ') text += ' '; }
  while (stack.length) {
    var w = stack.pop();
    if (w === BREAK) { space(); continue; }
    if (++visited > 1000000) break;
    if (w.nodeType === 3) {
      var d = norm(w.data);
      if (d.charAt(0) === ' ' && (!text.length || text.charAt(text.length - 1) === ' ')) d = d.slice(1);
      if (!d) continue;
      if (d !== ' ') parts.push({ start: text.length, end: text.length + d.length, el: w.parentNode });
      text += d;
      continue;
    }
    if (w.nodeType === 1) {
      var tag = String(w.localName || '').toLowerCase();
      if (SKIP[tag] || w.hidden || (w.hasAttribute && w.hasAttribute('hidden'))) continue;
      if (BLOCK[tag]) { space(); stack.push(BREAK); }
    } else if (w.nodeType !== 9 && w.nodeType !== 11) {
      continue;
    }
    for (var c = w.lastChild; c; c = c.previousSibling) stack.push(c);
  }

  // element wrappers are not identity-stable in Obscura: cache by node id
  var seen = {};
  function shown(el) {
    var key = el._nid;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(seen, key)) return seen[key];
    var ok = false;
    try {
      // Obscura lays out some visible inline elements (e.g. an inline element after a block sibling)
      // with a 0x0 box, so requiring the element's own box to be non-zero would wrongly hide on-screen
      // text. Treat it as visible when it (or an ancestor) has a real box and no ancestor is actually
      // hidden by display:none / visibility:hidden / the hidden attribute.
      var hasBox = false;
      for (var b = el, i = 0; b && b.nodeType === 1 && i < 200; b = b.parentNode, i++) {
        var rb = b.getBoundingClientRect();
        if (rb.width > 0 && rb.height > 0) { hasBox = true; break; }
      }
      ok = hasBox;
      for (var n = el, depth = 0; ok && n && n.nodeType === 1 && depth < 200; n = n.parentNode, depth++) {
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') ok = false;
        else if (n.hasAttribute && n.hasAttribute('hidden')) ok = false;
      }
    } catch (_e) { ok = false; }
    if (key !== undefined) seen[key] = ok;
    return ok;
  }
  var inDom = false, first = 0;
  for (var from = 0, idx; (idx = text.indexOf(want, from)) >= 0; from = idx + 1) {
    inDom = true;
    var end = idx + want.length, all = true;
    while (first < parts.length && parts[first].end <= idx) first++;
    for (var k = first; k < parts.length && parts[k].start < end; k++) {
      if (!parts[k].el || !shown(parts[k].el)) { all = false; break; }
    }
    if (all) return { visible: true, inDom: true };
  }
  return { visible: false, inDom: inDom };
}`;

interface SelectorStatus {
  count: number;
  visible: boolean;
}

interface TextState {
  visible: boolean;
  inDom: boolean;
}

type SelectorWaitState = 'visible' | 'attached' | 'hidden' | 'detached';

/** Resolves after `ms`, or early when the calling run is stopped (a cancelled sub-agent or script). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Deadline in ms, kept below the tool-call timeout so the wait can report its own result. */
function waitBudgetMs(ctx: ToolContext, timeoutSec: number | undefined): number {
  const requested = Math.round((timeoutSec ?? 30) * 1000);
  return Math.max(0, Math.min(requested, ctx.config.browser.toolTimeoutMs - 3_000));
}

/**
 * Poll `check` with short, independent evaluations (never one long
 * awaitPromise, which would block the CDP connection and the live view).
 * Errors while the page is navigating count as "not yet".
 */
async function poll<T>(
  tab: Tab,
  budgetMs: number,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  signal?: AbortSignal,
): Promise<{ ok: boolean; elapsedMs: number; last: T | null }> {
  const started = Date.now();
  let last: T | null = null;
  for (;;) {
    try {
      last = await read();
      if (done(last)) return { ok: true, elapsedMs: Date.now() - started, last };
    } catch (err) {
      if (!(err instanceof JavaScriptError || err instanceof CdpError)) throw err;
      last = null;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= budgetMs || tab.closed) return { ok: false, elapsedMs: elapsed, last };
    const interval = elapsed < 1_000 ? 100 : 250;
    await sleep(Math.min(interval, budgetMs - elapsed), signal);
    if (signal?.aborted) throw new ToolError('Stopped: the run was cancelled.');
  }
}

function navigationDuring(tab: Tab, navSeqBefore: number): string {
  return tab.navSeq !== navSeqBefore ? `\nThe page navigated during the wait (now ${tab.url}); element refs were reset.` : '';
}

function selectorReached(state: SelectorWaitState, s: SelectorStatus): boolean {
  switch (state) {
    case 'attached':
      return s.count > 0;
    case 'detached':
      return s.count === 0;
    case 'hidden':
      return s.count === 0 || !s.visible;
    default:
      return s.count > 0 && s.visible;
  }
}

export const waitFor = defineTool({
  name: 'browser_wait_for',
  title: 'Wait for element',
  group: 'core',
  description:
    'Wait until an element matching a CSS selector is visible (default), attached, hidden or detached. ' +
    'Use after an action that loads content asynchronously (search results, dialogs, lazy lists) before reading or clicking it.',
  inputSchema: z.object({
    selector: z.string().min(1).describe('CSS selector to wait for, e.g. "#results li"'),
    state: z
      .enum(['visible', 'attached', 'hidden', 'detached'])
      .optional()
      .describe('"visible" (default): present with a non-empty box; "attached": present in the DOM; "hidden": missing or invisible; "detached": removed from the DOM'),
    timeout: z.number().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Maximum seconds to wait (default 30, max ${MAX_WAIT_SECONDS}; fractions allowed)`),
  }),
  annotations: { ...READ_ONLY, title: 'Wait for element' },
  handler: async ({ selector, state, timeout }, ctx) => {
    const tab = await ctx.tab();
    const wanted: SelectorWaitState = state ?? 'visible';
    const syntax = await tab.callFunction<{ error: string | null; supported: boolean | null }>(SELECTOR_CHECK, [selector]);
    if (syntax?.error) throw new ToolError(`Invalid CSS selector ${JSON.stringify(selector)}: ${syntax.error}`);
    if (syntax?.supported === false) throw new ToolError(`Invalid CSS selector ${JSON.stringify(selector)}: the browser cannot parse it. Check the syntax (jQuery extensions such as :contains() are not CSS).`);

    const navSeq = tab.navSeq;
    const budget = waitBudgetMs(ctx, timeout);
    const { ok, elapsedMs, last } = await poll(
      tab,
      budget,
      () => tab.callFunction<SelectorStatus>(SELECTOR_STATUS, [selector]),
      (s) => selectorReached(wanted, s),
      ctx.signal,
    );
    const sel = JSON.stringify(selector);
    const nav = navigationDuring(tab, navSeq);
    if (ok) {
      switch (wanted) {
        case 'hidden':
          return textResult(`${sel} is hidden after ${seconds(elapsedMs)}${nav}`);
        case 'detached':
          return textResult(`${sel} is no longer in the page after ${seconds(elapsedMs)}${nav}`);
        default:
          return textResult(`Found ${sel} (${wanted}) after ${seconds(elapsedMs)}${nav}`);
      }
    }

    let current = '';
    if (last) {
      const many = last.count > 1 ? ` (${last.count} matches; the first one is checked)` : '';
      if (last.count === 0) current = 'no element matches it';
      else if (wanted === 'visible') current = `it is present but hidden${many}`;
      else if (wanted === 'hidden') current = `it is still visible${many}`;
      else if (wanted === 'detached') current = `it is still in the page (${last.count} match${last.count === 1 ? '' : 'es'})`;
    }
    throw new ToolError(
      `Timed out after ${seconds(elapsedMs)} waiting for ${sel} to be ${wanted}${current ? `: ${current}` : ''}. Page: ${tab.url}${nav}`,
    );
  },
});

export const waitForText = defineTool({
  name: 'browser_wait_for_text',
  title: 'Wait for text',
  group: 'core',
  description:
    'Wait until a piece of text is visible on the page (case-sensitive substring; runs of whitespace match any whitespace), or until it is no longer visible with gone=true. ' +
    'Text inside scripts or hidden elements does not count. Use to wait for a result or confirmation message, or for a "Loading…" indicator to go away.',
  inputSchema: z.object({
    text: z.string().min(1).describe('Text to look for (case-sensitive substring of the visible page text)'),
    gone: z.boolean().optional().describe('Wait for the text to disappear instead (default false)'),
    timeout: z.number().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Maximum seconds to wait (default 30, max ${MAX_WAIT_SECONDS}; fractions allowed)`),
  }),
  annotations: { ...READ_ONLY, title: 'Wait for text' },
  handler: async ({ text, gone, timeout }, ctx) => {
    if (!text.trim()) throw new ToolError('Provide some non-whitespace text to wait for');
    const tab = await ctx.tab();
    const navSeq = tab.navSeq;
    const budget = waitBudgetMs(ctx, timeout);
    const { ok, elapsedMs, last } = await poll(
      tab,
      budget,
      () => tab.callFunction<TextState>(TEXT_STATE, [text]),
      (s) => s.visible !== Boolean(gone),
      ctx.signal,
    );
    const quoted = JSON.stringify(text);
    const nav = navigationDuring(tab, navSeq);
    if (ok) return textResult(gone ? `Text ${quoted} is gone after ${seconds(elapsedMs)}${nav}` : `Found text ${quoted} after ${seconds(elapsedMs)}${nav}`);
    const detail = gone ? ' (it is still visible)' : last?.inDom ? ' (it is in the page but hidden)' : '';
    throw new ToolError(`Timed out after ${seconds(elapsedMs)} waiting for text ${quoted} to ${gone ? 'disappear' : 'appear'}${detail}. Page: ${tab.url}${nav}`);
  },
});

export const wait = defineTool({
  name: 'browser_wait',
  title: 'Wait',
  group: 'core',
  description:
    'Pause for a number of seconds so the page can finish animations or background loading. ' +
    'Prefer browser_wait_for or browser_wait_for_text when you know what you are waiting for.',
  inputSchema: z.object({
    seconds: z.number().min(0).max(30).describe('Seconds to wait (max 30; fractions allowed)'),
  }),
  annotations: { ...READ_ONLY, title: 'Wait' },
  handler: async ({ seconds: secs }, ctx) => {
    const ms = Math.max(0, Math.min(Math.round(secs * 1000), ctx.config.browser.toolTimeoutMs - 3_000));
    await sleep(ms, ctx.signal);
    if (ctx.signal?.aborted) throw new ToolError('Stopped: the run was cancelled.');
    return textResult(`Waited ${Number((ms / 1000).toFixed(3))} s`);
  },
});

export default [waitFor, waitForText, wait];
