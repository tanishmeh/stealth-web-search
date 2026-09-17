import * as z from 'zod';
import { ElementNotFoundError, JavaScriptError, ToolError } from '../browser/errors.ts';
import { EXTRACT_TEXT, GET_ATTRIBUTE, QUERY_COUNT, SELECTOR_PROBLEM } from '../browser/scripts.ts';
import type { ElementHandle, Tab } from '../browser/tab.ts';
import { DEFAULT_TEXT_LIMIT, pretty, truncate } from './format.ts';
import { targetShape } from './interaction.ts';
import { READ_ONLY, defineTool, textResult } from './types.ts';

/*
 * Page scripts used only by the content tools. They follow the rules in
 * browser/scripts.ts: plain function declarations, inputs passed as CDP call
 * arguments, nothing written to the DOM or to window globals. They are
 * String.raw literals so regular expressions read the same as in a .js file.
 *
 * Obscura notes that shaped them:
 *  - innerText is textContent there (no layout), so `<td>a</td><td>b</td>`
 *    reads "ab". TEXT_OF walks the tree and separates blocks and cells itself.
 *  - Invalid selectors do not throw; querySelector returns null and
 *    querySelectorAll returns nothing. SELECTOR_PROBLEM asks CSS.supports so a
 *    typo is reported instead of looking like "no match".
 *  - getComputedStyle costs ~0.4 ms per element, so page-wide walks only skip
 *    elements hidden by the `hidden` attribute or an inline style.
 */

/**
 * a basic link listing, plus: links without text are named by aria-label, title or an image's alt
 * text. When an href repeats with different text (e.g. HN's timestamp link and its "N comments"
 * link), all distinct texts are kept and joined with " | " so the link stays findable by any of
 * them. Also returns location.href so the handler needs no second round trip.
 */
const PAGE_LINKS_NAMED = String.raw`function pageLinks() {
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  var out = [], index = new Map();
  var as = document.querySelectorAll('a[href]');
  for (var i = 0; i < as.length; i++) {
    var a = as[i];
    var href = a.href || '';
    if (!href || /^javascript:/i.test(href)) continue;
    var text = clean(a.innerText || a.textContent);
    if (!text) text = clean(a.getAttribute('aria-label') || a.getAttribute('title'));
    if (!text) { var img = a.querySelector('img[alt]'); if (img) text = clean(img.getAttribute('alt')); }
    if (text.length > 200) text = Array.from(text).slice(0, 200).join('');
    var at = index.get(href);
    if (at === undefined) { index.set(href, out.length); out.push({ href: href, texts: text ? [text] : [] }); }
    else if (text && out[at].texts.indexOf(text) < 0) out[at].texts.push(text);
  }
  return { url: String(location.href), links: out.map(function (l) { return { text: l.texts.join(' | '), href: l.href }; }) };
}`;

/** `el` is hidden by the hidden attribute or an inline style (computed styles are too slow on Obscura). */
const IS_HIDDEN = String.raw`function isHidden(el) {
  if (el.hidden) return true;
  var st = el.getAttribute('style');
  return !!st && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(st);
}`;

/** Live form state for "value" / "checked" / "selected"; `undefined` when `name` is a plain attribute on `el`. Password values are masked. */
const FORM_STATE = String.raw`function formState(el, name) {
  var lower = String(name).toLowerCase();
  var tag = String(el.tagName || '').toUpperCase();
  var type = String(el.getAttribute('type') || '').toLowerCase();
  if (lower === 'value' && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
    var v = el.value == null ? '' : String(el.value);
    return tag === 'INPUT' && type === 'password' && v ? '••••' : v;
  }
  if (lower === 'checked' && tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) return !!el.checked;
  if (lower === 'selected' && tag === 'OPTION') return !!el.selected;
  return undefined;
}`;

/**
 * Readable text of one element: one line per block, table cells separated by
 * spaces, whitespace collapsed, <pre> kept verbatim. Form controls give their
 * current value (password values are masked).
 */
const TEXT_OF = String.raw`function textOf(root) {
  var SKIP = {script:1,style:1,noscript:1,template:1,head:1,select:1,datalist:1,textarea:1,svg:1,iframe:1,object:1,video:1,audio:1,canvas:1};
  var BLOCK = {address:1,article:1,aside:1,blockquote:1,body:1,caption:1,dd:1,details:1,dialog:1,div:1,dl:1,dt:1,fieldset:1,figcaption:1,figure:1,footer:1,form:1,
    h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,header:1,hgroup:1,hr:1,legend:1,li:1,main:1,nav:1,ol:1,p:1,section:1,summary:1,table:1,tbody:1,thead:1,tfoot:1,tr:1,ul:1,search:1};
  var rootTag = String(root.localName || root.tagName || '').toLowerCase();
  if (rootTag === 'input' || rootTag === 'textarea') {
    var type = String(root.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return root.value ? '••••' : '';
    if (type === 'checkbox' || type === 'radio') return '';
    return String(root.value == null ? '' : root.value);
  }
  if (rootTag === 'select') {
    var opt = root.options && root.options[root.selectedIndex];
    return opt ? String(opt.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  var isHidden = ${IS_HIDDEN};
  var lines = [], line = '', visited = 0;
  function flush() {
    var t = line.replace(/[ \t\n\r\f\u00a0]+/g, ' ').trim();
    if (t) lines.push(t);
    line = '';
  }
  function walk(n, depth) {
    if (++visited > 1000000) return;
    if (n.nodeType === 3) { line += n.data || ''; return; }
    if (n.nodeType !== 1) return;
    var tag = String(n.localName || n.tagName || '').toLowerCase();
    if (depth > 0 && (SKIP[tag] || isHidden(n))) return;
    if (tag === 'br') { flush(); return; }
    if (tag === 'pre') {
      flush();
      var raw = String(n.textContent || '').split('\n');
      for (var i = 0; i < raw.length; i++) { var l = raw[i].trimEnd(); if (l.trim()) lines.push(l); }
      return;
    }
    var block = BLOCK[tag] === 1;
    if (block) flush();
    if (depth > 1000) line += n.textContent || '';
    else for (var c = n.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
    if (tag === 'td' || tag === 'th') line += ' ';
    if (block) flush();
  }
  walk(root, 0);
  flush();
  return lines.join('\n');
}`;

/** `this` = element. */
const ELEMENT_TEXT = String.raw`function elementText() {
  var textOf = ${TEXT_OF};
  return textOf(this);
}`;

/**
 * `this` = element. GET_ATTRIBUTE, except that value/checked/selected of form
 * controls report the live state (the HTML attribute keeps the page's default
 * after the user or agent edits the field) and password values never leave the page.
 */
const ELEMENT_ATTRIBUTE = String.raw`function elementAttribute(name) {
  var formState = ${FORM_STATE};
  var state = formState(this, name);
  if (state !== undefined) return String(state);
  var getAttr = ${GET_ATTRIBUTE};
  return getAttr.call(this, name);
}`;

/**
 * Structured extraction. `fields` are parsed in Node:
 * [{ selector, attr (string|null), many (boolean) }]. Returns one
 * { value, error? } per field; empty results are checked for selector errors.
 */
const EXTRACT_FIELDS = String.raw`function extractFields(fields) {
  var textOf = ${TEXT_OF};
  var selectorProblem = ${SELECTOR_PROBLEM};
  var formState = ${FORM_STATE};
  function read(el, attr) {
    if (!attr) return textOf(el);
    var state = formState(el, attr);
    if (state !== undefined) return state;
    var lower = attr.toLowerCase();
    if ((lower === 'href' || lower === 'src') && el.hasAttribute(attr) && typeof el[lower] === 'string' && el[lower]) return el[lower];
    var v = el.getAttribute(attr);
    if (v === null && lower === 'value' && 'value' in el) v = el.value == null ? null : String(el.value);
    return v;
  }
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], res = {};
    try {
      if (f.many) {
        var els = document.querySelectorAll(f.selector), arr = [];
        for (var j = 0; j < els.length; j++) arr.push(read(els[j], f.attr));
        res.value = arr;
      } else {
        var el = document.querySelector(f.selector);
        res.value = el ? read(el, f.attr) : null;
      }
      if (res.value === null || (f.many && res.value.length === 0)) {
        var problem = selectorProblem(f.selector);
        if (problem) res.error = problem;
      }
    } catch (e) {
      res.value = f.many ? [] : null;
      res.error = String((e && e.message) || e);
    }
    out.push(res);
  }
  return out;
}`;

/**
 * HTML to Markdown for the page or one element. Compared with Obscura's own
 * converter it keeps code indentation (also inside quotes and list
 * items), emits tight and nested lists, numbers ordered lists, writes real
 * tables (header separator, no blank lines between rows) but renders layout
 * tables (tables of tables, role=presentation) as blocks, collapses source
 * whitespace and never inlines data: URLs.
 * Private-use characters mark code blocks (U+E000/E001), list indentation
 * (U+E002) and soft block breaks (U+E003) until the final clean-up; they are
 * stripped from page text first so a page cannot forge them.
 */
const PAGE_MARKDOWN_TIDY = String.raw`function pageMarkdown(rootSelector) {
  var root = rootSelector ? document.querySelector(rootSelector) : (document.body || document.documentElement);
  if (!root) return null;
  var BT = '\x60', IND = '\uE002', SOFT = '\uE003';
  var codes = [], visited = 0;
  var SKIP = {script:1,style:1,noscript:1,template:1,svg:1,canvas:1,iframe:1,object:1,embed:1,video:1,audio:1,link:1,meta:1,head:1,title:1,select:1,datalist:1,textarea:1,input:1};
  var BLOCK = {address:1,article:1,aside:1,body:1,caption:1,center:1,dd:1,details:1,dialog:1,div:1,dl:1,dt:1,fieldset:1,figcaption:1,figure:1,footer:1,form:1,
    header:1,hgroup:1,html:1,legend:1,main:1,nav:1,search:1,section:1,summary:1,tbody:1,tfoot:1,thead:1,tr:1};
  var isHidden = ${IS_HIDDEN};
  function clean(s) { return String(s == null ? '' : s).replace(/[\uE000-\uE003]/g, ''); }
  function restore(s) { return s.replace(/\uE000(\d+)\uE001/g, function(_m, i) { return codes[+i]; }); }
  /** A code block alone on its line repeats that line's prefix ("> ", list indentation) on every code line. */
  function restoreBlocks(s) {
    return restore(s.replace(/^([^\n\uE000]*)\uE000(\d+)\uE001[ \t]*$/gm, function(_m, prefix, i) {
      var blank = prefix.replace(/\s+$/, '');
      return codes[+i].split('\n').map(function(l) { return l ? prefix + l : blank; }).join('\n');
    }));
  }
  function tidy(s) {
    return s.replace(/ {2,}/g, ' ')
      .replace(/[ \t]*\uE003[\s\uE003]*/g, function(m) { return (m.match(/\n/g) || []).length >= 2 ? '\n\n' : '\n'; })
      .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function flat(s) {
    return restore(s).replace(/[\uE002\uE003]/g, ' ').replace(/\n[ \t]*(?:#{1,6}|>|-|\d+\.) /g, ' ').replace(/(?:^|\n)[ \t]*---[ \t]*(?=\n|$)/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function wrap(s, mark) {
    var core = s.trim();
    if (!core) return s;
    return (/^\s/.test(s) ? ' ' : '') + mark + core.replace(/\s+/g, ' ') + mark + (/\s$/.test(s) ? ' ' : '');
  }
  function mdUrl(u) { return clean(u).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29'); }
  function children(el, ctx) {
    var s = '';
    for (var c = el.firstChild; c; c = c.nextSibling) s += conv(c, ctx);
    return s;
  }
  function list(el, ctx, ordered) {
    var n = ordered ? parseInt(el.getAttribute('start') || '1', 10) : 0;
    if (isNaN(n)) n = 1;
    var out = [];
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      var t = String(c.localName || '').toLowerCase();
      if (SKIP[t] || isHidden(c)) continue;
      if (t !== 'li') {
        var other = tidy(conv(c, ctx));
        if (other) out.push(other);
        continue;
      }
      var marker = ordered ? (n++) + '. ' : '- ';
      var pad = '';
      for (var k = 0; k < marker.length; k++) pad += IND;
      var body = tidy(children(c, { depth: ctx.depth + 1, indent: ctx.indent + pad })).replace(/\n{2,}/g, '\n');
      if (!body) continue;
      var lines = body.split('\n');
      // nested content (already indented) and code blocks start on the line after the marker
      var first = lines[0].charAt(0) === IND || /^\uE000\d+\uE001$/.test(lines[0]) ? '' : lines.shift();
      out.push(ctx.indent + marker + first);
      for (var j = 0; j < lines.length; j++) out.push(lines[j].charAt(0) === IND ? lines[j] : ctx.indent + pad + lines[j]);
    }
    return out.length ? '\n\n' + out.join('\n') + '\n\n' : '';
  }
  function table(el, ctx) {
    var rows = [], caption = '';
    (function collect(node, depth) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || isHidden(c)) continue;
        var t = String(c.localName || '').toLowerCase();
        if (t === 'tr') rows.push(c);
        else if ((t === 'thead' || t === 'tbody' || t === 'tfoot') && depth < 1) collect(c, depth + 1);
        else if (t === 'caption') caption = flat(children(c, ctx));
      }
    })(el, 0);
    // Rows holding a nested table (and every row of a role=presentation table) lay out
    // other content: their cells become blocks. Runs of the other rows become Markdown tables.
    var role = String(el.getAttribute('role') || '').toLowerCase();
    var presentation = role === 'presentation' || role === 'none';
    var parts = [], run = [];
    function endRun() {
      if (!run.length) return;
      var md = grid(run, ctx);
      if (md) parts.push(md);
      run = [];
    }
    for (var r = 0; r < rows.length; r++) {
      var cells = [];
      for (var c = rows[r].firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || isHidden(c)) continue;
        var t = String(c.localName || '').toLowerCase();
        if (t === 'td' || t === 'th') cells.push(c);
      }
      if (!cells.length) continue;
      var layoutRow = presentation;
      for (var lc = 0; !layoutRow && lc < cells.length; lc++) { try { layoutRow = !!cells[lc].querySelector('table'); } catch (_e) {} }
      if (!layoutRow) { run.push(cells); continue; }
      endRun();
      for (var bc = 0; bc < cells.length; bc++) {
        var block = tidy(children(cells[bc], ctx));
        if (block) parts.push(block);
      }
    }
    endRun();
    if (!parts.length) return '';
    return '\n\n' + (caption ? caption + '\n\n' : '') + parts.join('\n\n') + '\n\n';
  }
  /** Rows of cell elements as a Markdown table (colspan expanded, empty rows dropped); one column gives one block per cell. */
  function grid(matrix, ctx) {
    var width = 0, i, j;
    for (i = 0; i < matrix.length; i++) {
      var w = 0;
      for (j = 0; j < matrix[i].length; j++) w += span(matrix[i][j]);
      if (w > width) width = w;
    }
    if (width === 1) {
      var blocks = [];
      for (i = 0; i < matrix.length; i++) { var b = tidy(children(matrix[i][0], ctx)); if (b) blocks.push(b); }
      return blocks.join('\n');
    }
    var lines = [];
    for (i = 0; i < matrix.length; i++) {
      var row = [], filled = false;
      for (j = 0; j < matrix[i].length; j++) {
        var text = flat(children(matrix[i][j], ctx)).replace(/\|/g, '\\|');
        if (text) filled = true;
        row.push(text);
        for (var s = span(matrix[i][j]); s > 1; s--) row.push('');
      }
      if (!filled) continue;
      while (row.length < width) row.push('');
      lines.push('| ' + row.join(' | ') + ' |');
      if (lines.length === 1) {
        var sep = [];
        for (j = 0; j < width; j++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    }
    return lines.join('\n');
  }
  function span(cell) {
    var n = parseInt(cell.getAttribute('colspan') || '1', 10);
    return isNaN(n) || n < 1 ? 1 : Math.min(n, 20);
  }
  function conv(node, ctx) {
    if (++visited > 300000) return '';
    if (node.nodeType === 3) return clean(node.data).replace(/[ \t\n\r\f ]+/g, ' ');
    if (node.nodeType !== 1) return '';
    var tag = String(node.localName || node.tagName || '').toLowerCase();
    if (SKIP[tag] || (ctx.depth > 0 && isHidden(node))) return '';
    if (ctx.depth > 500) return clean(node.textContent).replace(/\s+/g, ' ');
    var sub = { depth: ctx.depth + 1, indent: ctx.indent };
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        var h = flat(children(node, sub));
        return h ? '\n\n' + '######'.slice(0, +tag.charAt(1)) + ' ' + h + '\n\n' : '';
      }
      case 'p': {
        var p = children(node, sub).trim();
        return p ? '\n\n' + p + '\n\n' : '';
      }
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': return wrap(children(node, sub), '**');
      case 'em': case 'i': case 'cite': case 'dfn': return wrap(children(node, sub), '*');
      case 's': case 'del': case 'strike': return wrap(children(node, sub), '~~');
      case 'code': case 'kbd': case 'samp': case 'tt': {
        var code = clean(node.textContent).replace(/\s+/g, ' ');
        if (!code.trim()) return code;
        return code.indexOf(BT) >= 0 ? BT + BT + ' ' + code + ' ' + BT + BT : BT + code + BT;
      }
      case 'pre': {
        var text = clean(node.textContent).replace(/^\n/, '').trimEnd();
        if (!text) return '';
        var fence = text.indexOf(BT + BT + BT) >= 0 ? '~~~' : BT + BT + BT;
        var classes = String(node.getAttribute('class') || '');
        for (var fc = node.firstChild; fc; fc = fc.nextSibling) { if (fc.nodeType === 1) { classes += ' ' + String(fc.getAttribute('class') || ''); break; } }
        var lang = /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(classes);
        codes.push(fence + (lang ? lang[1] : '') + '\n' + text + '\n' + fence);
        return '\n\n\uE000' + (codes.length - 1) + '\uE001\n\n';
      }
      case 'blockquote': {
        var q = tidy(children(node, sub));
        return q ? '\n\n' + q.split('\n').map(function(l) { return l ? '> ' + l : '>'; }).join('\n') + '\n\n' : '';
      }
      case 'a': {
        var inner = children(node, sub);
        var hrefAttr = node.getAttribute('href');
        if (hrefAttr === null || /^\s*javascript:/i.test(hrefAttr)) return inner;
        var label = flat(inner);
        if (!label || /^!\[\]\([^)]*\)$/.test(label)) label = clean(node.getAttribute('aria-label') || node.getAttribute('title') || label).replace(/\s+/g, ' ').trim();
        if (!label) return inner;
        return (/^\s/.test(inner) ? ' ' : '') + '[' + label + '](' + mdUrl(node.href || hrefAttr) + ')' + (/\s$/.test(inner) ? ' ' : '');
      }
      case 'img': {
        var alt = clean(node.getAttribute('alt')).replace(/\s+/g, ' ').trim();
        var src = node.getAttribute('src') ? (node.src || node.getAttribute('src')) : '';
        if (!src && node.getAttribute('data-src')) { try { src = new URL(node.getAttribute('data-src'), document.baseURI).href; } catch (_e) { src = ''; } }
        if (!src) return alt;
        if (/^data:/i.test(src)) return alt ? '![' + alt + '](data:...)' : '';
        return '![' + alt + '](' + mdUrl(src) + ')';
      }
      case 'ul': case 'ol': return list(node, sub, tag === 'ol');
      case 'li': {
        var item = flat(children(node, sub));
        return item ? '\n- ' + item + '\n' : '';
      }
      case 'table': return table(node, sub);
      default: {
        var rest = children(node, sub);
        if (tag === 'td' || tag === 'th') return ' ' + rest + ' ';
        return BLOCK[tag] ? SOFT + rest + SOFT : rest;
      }
    }
  }
  return restoreBlocks(tidy(conv(root, { depth: 0, indent: '' })).replace(/\uE002/g, ' '));
}`;

// ------------------------------------------------------------------ helpers

function invalidSelector(selector: string, detail: string): ToolError {
  return new ToolError(`Invalid or unsupported CSS selector ${JSON.stringify(selector)}: ${detail.replace(/^JavaScript error:\s*/, '')}`);
}

function requireSelector(selector: string): string {
  if (!selector.trim()) throw new ToolError('selector must not be empty');
  return selector;
}

/** Throw a ToolError when the page cannot parse `selector`. */
async function assertParsableSelector(tab: Tab, selector: string): Promise<void> {
  const problem = await tab.callFunction<string | null>(SELECTOR_PROBLEM, [selector]);
  if (problem) throw invalidSelector(selector, problem);
}

/**
 * Run a page script that takes a selector; standard engines throw on bad
 * selectors. Other script errors (e.g. a page that broke a DOM API) are
 * passed on as they are instead of being blamed on the selector.
 */
async function withSelector<T>(tab: Tab, selector: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof JavaScriptError) {
      const problem = await tab.callFunction<string | null>(SELECTOR_PROBLEM, [selector]).catch(() => null);
      if (problem) throw invalidSelector(selector, problem);
    }
    throw err;
  }
}

/** tab.resolveElement, but a selector that cannot be parsed is reported as such instead of "not found". */
async function resolveTarget(tab: Tab, ref: string | undefined, selector: string | undefined): Promise<ElementHandle> {
  try {
    return await tab.resolveElement({ ref, selector });
  } catch (err) {
    if (err instanceof ElementNotFoundError && selector && !ref) await assertParsableSelector(tab, selector);
    throw err;
  }
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g;
const MAX_SEARCH_MATCHES = 10_000;
/** How far a snippet may grow to avoid cutting a word in half. */
const WORD_WIDEN_CHARS = 24;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Context around text[start, end): `context` chars each side, widened to whole words, whitespace collapsed. */
export function searchSnippet(text: string, start: number, end: number, context: number): string {
  let s = Math.max(0, start - context);
  let e = Math.min(text.length, end + context);
  if (s > 0 && !isSpace(text[s - 1]) && !isSpace(text[s])) {
    let i = s;
    const limit = Math.max(0, s - WORD_WIDEN_CHARS);
    while (i > limit && !isSpace(text[i - 1])) i--;
    if (i === 0 || isSpace(text[i - 1])) s = i;
  }
  if (e < text.length && !isSpace(text[e - 1]) && !isSpace(text[e])) {
    let j = e;
    const limit = Math.min(text.length, e + WORD_WIDEN_CHARS);
    while (j < limit && !isSpace(text[j])) j++;
    if (j === text.length || isSpace(text[j])) e = j;
  }
  // never split a surrogate pair
  if (s > 0 && s < text.length && /[\uDC00-\uDFFF]/.test(text[s]!)) s--;
  if (e > 0 && e < text.length && /[\uD800-\uDBFF]/.test(text[e - 1]!)) e++;
  const body = text.slice(s, e).replace(/\s+/g, ' ').trim();
  return `${s > 0 ? '…' : ''}${body}${e < text.length ? '…' : ''}`;
}

export interface SearchMatch {
  offset: number;
  snippet: string;
}

/**
 * All non-overlapping matches of `query` in `text`. Offsets are JavaScript
 * string indices (UTF-16 code units). Case-insensitive matching uses Unicode
 * case folding, so offsets always point into the original text. Whitespace in
 * the query matches any run of whitespace, so a phrase copied from a snippet
 * (where line breaks are shown as spaces) is found again.
 */
export function findMatches(
  text: string,
  query: string,
  opts: { caseSensitive: boolean; limit: number; context: number },
): { total: number; capped: boolean; matches: SearchMatch[] } {
  const pattern = query
    .split(/\s+/)
    .map((part) => part.replace(REGEXP_SYNTAX, '\\$&'))
    .join('\\s+');
  const re = new RegExp(pattern, opts.caseSensitive ? 'gu' : 'giu');
  const matches: SearchMatch[] = [];
  let total = 0;
  let capped = false;
  for (let guard = 0; guard <= text.length + 1; guard++) {
    const m = re.exec(text);
    if (!m) break;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    total++;
    if (matches.length < opts.limit) {
      matches.push({ offset: m.index, snippet: searchSnippet(text, m.index, m.index + m[0].length, opts.context) });
    }
    if (total >= MAX_SEARCH_MATCHES) {
      capped = re.exec(text) !== null;
      break;
    }
  }
  return { total, capped, matches };
}

interface ExtractField {
  name: string;
  selector: string;
  attr: string | null;
  many: boolean;
}

/** `"field[]"` → array, `"selector@attr"` → attribute. An `@` inside brackets or quotes is part of the selector. */
export function parseExtractSchema(schema: Record<string, unknown>): ExtractField[] {
  const entries = Object.entries(schema);
  if (entries.length === 0) {
    throw new ToolError('schema must map at least one field name to a CSS selector, e.g. {"title": "h1", "links[]": "a@href"}');
  }
  const fields: ExtractField[] = [];
  const seen = new Set<string>();
  for (const [key, spec] of entries) {
    const many = key.length > 2 && key.endsWith('[]');
    const name = many ? key.slice(0, -2) : key;
    if (!name.trim()) throw new ToolError(`schema field names must not be empty (got ${JSON.stringify(key)})`);
    if (seen.has(name)) throw new ToolError(`schema defines the field "${name}" twice ("${name}" and "${name}[]")`);
    seen.add(name);
    if (typeof spec !== 'string') {
      throw new ToolError(`schema field "${key}" must be a CSS selector string, got ${spec === null ? 'null' : Array.isArray(spec) ? 'an array' : typeof spec}`);
    }
    const trimmed = spec.trim();
    const m = /^([\s\S]+?)\s*@\s*([A-Za-z_:][-\w:.]*)$/.exec(trimmed);
    const selector = (m ? m[1]! : trimmed).trim();
    if (!selector) throw new ToolError(`schema field "${key}" has an empty selector`);
    fields.push({ name, selector, attr: m ? m[2]! : null, many });
  }
  return fields;
}

/** Opaque origins (about:blank, data:, mailto:, …) serialize as "null" and are never the same origin as anything. */
function sameOrigin(href: string, base: URL | null): boolean {
  if (!base || base.origin === 'null') return false;
  try {
    const origin = new URL(href).origin;
    return origin !== 'null' && origin === base.origin;
  } catch {
    return false;
  }
}

/** Some local models send nested objects as JSON text; accept that for object inputs. */
function parseJsonObjectText(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*\{/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

// ------------------------------------------------------------------ tools

export const markdown = defineTool({
  name: 'browser_markdown',
  title: 'Read page as Markdown',
  group: 'content',
  description:
    'Return the current page (or one element) as Markdown: headings, paragraphs, lists, tables, code blocks, quotes, links and images with absolute URLs. ' +
    'Best for reading articles, docs and other long content; use browser_snapshot instead when you need element refs to interact.',
  inputSchema: z.object({
    max_chars: z.number().int().min(1).max(500_000).optional().describe('Maximum characters to return (default 8000); longer output is truncated'),
    selector: z.string().optional().describe('CSS selector of the element to convert (e.g. "main", "article"); omit for the whole page'),
  }),
  annotations: { ...READ_ONLY, title: 'Read page as Markdown' },
  handler: async ({ max_chars, selector }, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    // an empty optional selector (common from small models) means the whole page
    const root = selector?.trim() ? selector : null;
    const convert = () => tab.callFunction<string | null>(PAGE_MARKDOWN_TIDY, [root]);
    const md = root === null ? await convert() : await withSelector(tab, root, convert);
    if (md === null) {
      if (root === null) return textResult('(page has no readable content)');
      await assertParsableSelector(tab, root);
      throw new ElementNotFoundError(`selector ${JSON.stringify(root)}`);
    }
    if (!md.trim()) return textResult(root === null ? '(page has no readable content)' : `(element ${JSON.stringify(root)} has no readable content)`);
    return textResult(truncate(md, max_chars ?? 8000));
  },
});

export const links = defineTool({
  name: 'browser_links',
  title: 'List links',
  group: 'content',
  description:
    'List the links on the current page, one JSON object per line: {"text","href"} with absolute, de-duplicated URLs (javascript: links are skipped). ' +
    'Use it to decide where to navigate next; narrow the list with internal_only or filter.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of links to return (default 100)'),
    internal_only: z.boolean().optional().describe('Only links on the same origin (scheme, host and port) as the current page'),
    filter: z.string().optional().describe('Only links whose text or URL contains this text (case-insensitive)'),
  }),
  annotations: { ...READ_ONLY, title: 'List links' },
  handler: async ({ limit, internal_only, filter }, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    const page = await tab.callFunction<{ url: string; links: Array<{ text: string; href: string }> } | null>(PAGE_LINKS_NAMED);
    const all = page?.links ?? [];
    let base: URL | null = null;
    try {
      base = new URL(page?.url ?? tab.url);
    } catch {
      base = null;
    }
    const needle = filter?.trim().toLowerCase() ?? '';
    const matching = all.filter((link) => {
      if (internal_only && !sameOrigin(link.href, base)) return false;
      if (!needle) return true;
      return (
        link.text.toLowerCase().includes(needle) ||
        link.href.toLowerCase().includes(needle) ||
        safeDecode(link.href).toLowerCase().includes(needle)
      );
    });
    if (matching.length === 0) {
      if (all.length === 0) return textResult('No links found.');
      const criteria = [internal_only ? 'internal_only' : '', needle ? `filter ${JSON.stringify(filter!.trim())}` : ''].filter(Boolean).join(', ');
      return textResult(`No links found matching ${criteria} (the page has ${all.length} link${all.length === 1 ? '' : 's'} in total).`);
    }
    const max = limit ?? 100;
    const lines = matching.slice(0, max).map((link) => JSON.stringify({ text: link.text, href: link.href }));
    if (matching.length > max) lines.push(`…${matching.length - max} more link(s) (raise limit to see them).`);
    return textResult(lines.join('\n'));
  },
});

export const search = defineTool({
  name: 'browser_search',
  title: 'Search page text',
  group: 'content',
  description:
    'Find a word or phrase in the page text (the same text browser_snapshot shows) and return each match with surrounding context. ' +
    'Use it to check that content exists or to locate a section before reading or scraping it. ' +
    'Each match is a JSON line {"offset","snippet"}; offset is the JavaScript string index (UTF-16 code units) of the match in that text.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Text to find (plain text, not a regular expression; spaces also match line breaks)'),
    case_sensitive: z.boolean().optional().describe('Match letter case exactly (default false)'),
    limit: z.number().int().min(1).max(1000).optional().describe('Maximum matches to return (default 10)'),
    context_chars: z.number().int().min(0).max(2000).optional().describe('Characters of context on each side of a match (default 80)'),
  }),
  annotations: { ...READ_ONLY, title: 'Search page text' },
  handler: async ({ query, case_sensitive, limit, context_chars }, ctx) => {
    if (!query.trim()) throw new ToolError('query must contain at least one non-whitespace character');
    const tab = await ctx.tab();
    await tab.guardDocument();
    const text = (await tab.callFunction<string | null>(EXTRACT_TEXT, [null])) ?? '';
    const found = findMatches(text, query, {
      caseSensitive: case_sensitive ?? false,
      limit: limit ?? 10,
      context: context_chars ?? 80,
    });
    if (found.total === 0) return textResult(`No matches for ${JSON.stringify(query)}.`);
    const lines = [
      `${found.total}${found.capped ? '+' : ''} match(es) for ${JSON.stringify(query)} (showing ${found.matches.length}):`,
      ...found.matches.map((m) => JSON.stringify(m)),
    ];
    if (found.total > found.matches.length) lines.push(`…${found.total - found.matches.length}${found.capped ? '+' : ''} more (raise limit to see them).`);
    return textResult(lines.join('\n'));
  },
});

export const extract = defineTool({
  name: 'browser_extract',
  title: 'Extract structured data',
  group: 'content',
  description:
    'Extract structured data from the page with CSS selectors and get one JSON object back. ' +
    'schema maps each output field to a selector: {"title": "h1"} gives the text of the first match; ' +
    'end the field name with [] for all matches as an array ({"prices[]": ".price"}); ' +
    'end the selector with @attribute to read an attribute ({"links[]": "a.result@href"}; href/src become absolute URLs, ' +
    '@value and @checked give the current state of form fields). ' +
    'Missing elements give null (or [] for arrays).',
  inputSchema: z.object({
    schema: z
      .preprocess(parseJsonObjectText, z.record(z.string(), z.unknown()))
      .describe('Object mapping field name to CSS selector string, e.g. {"title": "h1", "items[]": "li.item", "image": "img.hero@src"}'),
    max_chars: z.number().int().min(1).max(500_000).optional().describe('Maximum characters of JSON to return (default 20000); longer output is truncated'),
  }),
  annotations: { ...READ_ONLY, title: 'Extract structured data' },
  handler: async ({ schema, max_chars }, ctx) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new ToolError('schema must be an object mapping field names to CSS selectors');
    }
    const fields = parseExtractSchema(schema);
    const tab = await ctx.tab();
    await tab.guardDocument();
    const results = await tab.callFunction<Array<{ value: unknown; error?: string }>>(EXTRACT_FIELDS, [
      fields.map((f) => ({ selector: f.selector, attr: f.attr, many: f.many })),
    ]);
    const data: Record<string, unknown> = {};
    const errors: string[] = [];
    fields.forEach((field, i) => {
      const res = results[i] ?? { value: field.many ? [] : null };
      data[field.name] = res.value;
      if (res.error) errors.push(`- ${field.name}: invalid or unsupported CSS selector ${JSON.stringify(field.selector)} (${res.error})`);
    });
    let text = truncate(pretty(data), max_chars ?? 20_000);
    if (errors.length) text += `\nSelector errors:\n${errors.join('\n')}`;
    return textResult(text);
  },
});

export const count = defineTool({
  name: 'browser_count',
  title: 'Count matching elements',
  group: 'content',
  description:
    'Count the elements on the current page that match a CSS selector. A cheap way to check that something exists, ' +
    'how many results or rows a page has, or whether more items loaded.',
  inputSchema: z.object({
    selector: z.string().min(1).describe('CSS selector, e.g. ".result" or "table#prices tbody tr"'),
  }),
  annotations: { ...READ_ONLY, title: 'Count matching elements' },
  handler: async ({ selector }, ctx) => {
    requireSelector(selector);
    const tab = await ctx.tab();
    await tab.guardDocument();
    const n = await withSelector(tab, selector, () => tab.callFunction<number>(QUERY_COUNT, [selector]));
    if (!n) await assertParsableSelector(tab, selector);
    return textResult(`${n ?? 0} element(s) match ${JSON.stringify(selector)}`);
  },
});

export const getAttribute = defineTool({
  name: 'browser_get_attribute',
  title: 'Read element attribute',
  group: 'content',
  description:
    'Read one attribute of an element (href, src, value, class, aria-*, data-*, …) identified by ref (from browser_snapshot) or CSS selector. ' +
    'Returns the raw attribute value as written in the HTML (relative URLs stay relative; use browser_extract with "@href" for absolute URLs). ' +
    'Exception: "value" of inputs, textareas and selects and "checked" of checkboxes/radios return the current state ' +
    '(what was typed or toggled; "true"/"false" for checked), not the HTML default.',
  inputSchema: z.object({
    ...targetShape,
    attribute: z.string().min(1).describe('Attribute name, e.g. "href", "value", "data-id"'),
  }),
  annotations: { ...READ_ONLY, title: 'Read element attribute' },
  handler: async ({ ref, selector, attribute }, ctx) => {
    const name = attribute.trim();
    if (!name) throw new ToolError('attribute must not be empty');
    const tab = await ctx.tab();
    await tab.guardDocument();
    const handle = await resolveTarget(tab, ref, selector);
    const value = await tab.callFunction<string | null>(ELEMENT_ATTRIBUTE, [name], { objectId: handle.objectId });
    if (value === null || value === undefined) {
      return textResult(`Element ${await tab.describeElement(handle)} has no ${JSON.stringify(name)} attribute`);
    }
    if (value === '') {
      const desc = await tab.describeElement(handle);
      if (name.toLowerCase() === 'value') return textResult(`Element ${desc} has an empty value`);
      return textResult(`Element ${desc} has the ${JSON.stringify(name)} attribute with an empty value`);
    }
    return textResult(String(value));
  },
});

export const getText = defineTool({
  name: 'browser_get_text',
  title: 'Read element text',
  group: 'content',
  description:
    'Read the text of one element identified by ref (from browser_snapshot) or CSS selector: one line per block, whitespace collapsed. ' +
    'For inputs, textareas and selects it returns the current value. Use browser_markdown to read a whole section with its structure.',
  inputSchema: z.object({
    ...targetShape,
    max_chars: z.number().int().min(1).max(200_000).optional().describe(`Maximum characters to return (default ${DEFAULT_TEXT_LIMIT})`),
  }),
  annotations: { ...READ_ONLY, title: 'Read element text' },
  handler: async ({ ref, selector, max_chars }, ctx) => {
    const tab = await ctx.tab();
    await tab.guardDocument();
    const handle = await resolveTarget(tab, ref, selector);
    const text = (await tab.callFunction<string | null>(ELEMENT_TEXT, [], { objectId: handle.objectId })) ?? '';
    if (!text) return textResult(`Element ${await tab.describeElement(handle)} has no text.`);
    return textResult(truncate(text, max_chars ?? DEFAULT_TEXT_LIMIT));
  },
});

export default [markdown, links, search, extract, count, getAttribute, getText];
