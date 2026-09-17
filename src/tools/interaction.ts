import * as z from 'zod';
import { JavaScriptError, StaleRefError, ToolError } from '../browser/errors.ts';
import { ELEMENT_BOX, SCROLL_PAGE, SELECT_OPTION, SET_CHECKED, SET_VALUE } from '../browser/scripts.ts';
import { describeException, type ElementHandle, type PageInfo, type RemoteObject, type Tab } from '../browser/tab.ts';
import { CdpError } from '../cdp/client.ts';
import { ACTION, defineTool, textResult, type ToolContext } from './types.ts';

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  hitsSelf: boolean;
  tag: string;
  type: string;
  label: string;
  disabled: boolean;
  href: string;
  obscured: string | null;
  innerWidth: number;
  innerHeight: number;
  /** Page scroll offset, so a viewport box can be converted to document coordinates for screenshot clips. */
  scrollX: number;
  scrollY: number;
  error?: string;
}

export const targetShape = {
  ref: z.string().optional().describe('Element ref from browser_snapshot, e.g. "e3" (preferred)'),
  selector: z.string().optional().describe('CSS selector, used when no ref is available'),
};

/** Scroll the element into view and measure it. */
export async function measure(tab: Tab, handle: ElementHandle): Promise<ElementBox> {
  const box = await tab.callFunction<ElementBox>(ELEMENT_BOX, [true], { objectId: handle.objectId });
  if (box.error) {
    if (handle.ref) throw new StaleRefError(handle.ref);
    throw new ToolError(`Element ${handle.target} is no longer attached to the page`);
  }
  return box;
}

export function describeBox(box: ElementBox, handle: ElementHandle): string {
  const kind = box.type ? `${box.tag}[${box.type}]` : box.tag;
  const label = box.label ? ` ${JSON.stringify(box.label)}` : '';
  return `${kind}${label} (${handle.target})`;
}

/** Summarise navigation / URL changes caused by an action. */
export function navigationNote(outcome: { navigated: boolean; urlChanged: boolean; info: PageInfo }): string {
  if (outcome.navigated) return `\nThe page navigated to ${outcome.info.url} — ${JSON.stringify(outcome.info.title)}. Element refs were reset; call browser_snapshot.`;
  if (outcome.urlChanged) return `\nThe URL changed to ${outcome.info.url}.`;
  return '';
}

export async function mouseClick(tab: Tab, x: number, y: number, clickCount = 1, focusObjectId?: string): Promise<void> {
  const base = { x, y, button: 'left', buttons: 1, clickCount };
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  // Obscura does not focus on mousedown; text-entry controls get focus here, between press and release, like in a browser
  if (focusObjectId) await tab.callFunction(FOCUS_FOR_CLICK, [], { objectId: focusObjectId }).catch(() => undefined);
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
}

export interface NavigationOutcome<T> {
  result: T;
  navigated: boolean;
  urlChanged: boolean;
  info: PageInfo;
}

/**
 * Click an element the way browser_click does: real mouse events at its
 * centre when it is visible and not covered, otherwise a DOM click. Waits for
 * any navigation the click starts.
 */
export async function clickElement(
  ctx: ToolContext,
  tab: Tab,
  handle: ElementHandle,
  doubleClick = false,
): Promise<{ box: ElementBox; method: string; outcome: NavigationOutcome<void> }> {
  const box = await measure(tab, handle);
  if (box.disabled) throw new ToolError(`Element ${describeBox(box, handle)} is disabled`);

  let method = 'mouse';
  const outcome = await tab.trackNavigation(async () => {
    if (box.visible && box.hitsSelf) {
      ctx.pointer(tab, box.x, box.y, 'click', box.label);
      const navSeq = tab.navSeq;
      await mouseClick(tab, box.x, box.y, 1, handle.objectId);
      if (doubleClick && tab.navSeq === navSeq) await mouseClick(tab, box.x, box.y, 2);
    } else {
      // hidden, zero-size or covered by another element: fall back to a DOM click
      await tab.callFunction(
        `function(dbl){ this.click(); if (dbl) { this.click(); this.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); } }`,
        [Boolean(doubleClick)],
        { objectId: handle.objectId },
      );
      // activating a label focuses its control (Obscura lays out labels with an empty box, so they land here)
      if (box.tag === 'label') await tab.callFunction(FOCUS_FOR_CLICK, [], { objectId: handle.objectId }).catch(() => undefined);
      method = box.visible ? `programmatic (covered by ${box.obscured ?? 'another element'})` : 'programmatic (element not visible)';
    }
  });
  return { box, method, outcome };
}

export const click = defineTool({
  name: 'browser_click',
  title: 'Click element',
  group: 'core',
  description:
    'Click an element (link, button, checkbox, …) identified by ref (from browser_snapshot) or CSS selector. ' +
    'The element is scrolled into view and clicked with real mouse events; if the click navigates, the new page is loaded before returning.',
  inputSchema: z.object({
    ...targetShape,
    double_click: z.boolean().optional().describe('Double-click instead of a single click'),
  }),
  annotations: { ...ACTION, title: 'Click element' },
  handler: async ({ ref, selector, double_click }, ctx) => {
    const tab = await ctx.tab();
    const handle = await tab.resolveElement({ ref, selector });
    const { box, method, outcome } = await clickElement(ctx, tab, handle, Boolean(double_click));
    let text = `${double_click ? 'Double-clicked' : 'Clicked'} ${describeBox(box, handle)}`;
    if (method !== 'mouse') text += ` using a ${method} click`;
    text += navigationNote(outcome);
    return textResult(text);
  },
});

// ====================================================================== page scripts
//
// Function declarations run with Runtime.callFunctionOn; inputs arrive as call
// arguments. They never write attributes or globals into the page. Events they
// dispatch are marked trusted with Obscura's own helper, exactly like the
// events Obscura's Input domain generates.

/** Accessible-ish label of a form control or button (nested helper, concatenated into scripts below). */
export const LABEL_OF = `function labelOf(el) {
  function clean(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, 80); }
  var tag = el.tagName.toLowerCase();
  var t = clean(el.getAttribute('aria-label'));
  if (t) return t;
  var lb = el.getAttribute('aria-labelledby');
  if (lb) {
    t = clean(lb.split(/\\s+/).map(function (id) { var n = document.getElementById(id); return n ? (n.textContent || '') : ''; }).join(' '));
    if (t) return t;
  }
  if (el.id && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
    try {
      var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (lab) { t = clean(lab.innerText || lab.textContent); if (t) return t; }
    } catch (_e) {}
  }
  if ((tag === 'input' || tag === 'select' || tag === 'textarea') && el.closest) {
    var wrap = el.closest('label');
    if (wrap) { t = clean(wrap.innerText || wrap.textContent); if (t) return t; }
  }
  var ce = el.getAttribute('contenteditable');
  var editable = ce === '' || ce === 'true' || ce === 'plaintext-only';
  if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && !editable) { t = clean(el.innerText || el.textContent); if (t) return t; }
  if (tag === 'input' && ['button', 'submit', 'reset'].indexOf((el.getAttribute('type') || '').toLowerCase()) >= 0) { t = clean(el.value); if (t) return t; }
  return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '');
}`;

/**
 * Focus helpers (nested, concatenated into scripts below). Obscura's focus()
 * only sets document.activeElement; a browser also fires blur/focusout on the
 * previously focused element and focus/focusin on the new one, which pages use
 * for validation and "touched" state.
 */
const FOCUS_HELPERS = `
  function sameNode(a, b) { return !!a && !!b && (a === b || (a._nid !== undefined && a._nid === b._nid)); }
  function focusedElement() {
    var a = document.activeElement;
    return !a || sameNode(a, document.body) || sameNode(a, document.documentElement) ? null : a;
  }
  function fireFocusEvent(node, type, related) {
    var mark = globalThis.__obscura_markTrusted || function (e) { return e; };
    var bubbles = type === 'focusin' || type === 'focusout';
    var ev;
    try { ev = new FocusEvent(type, { bubbles: bubbles, composed: true, relatedTarget: related || null }); } catch (_e) { ev = new Event(type, { bubbles: bubbles }); }
    try { node.dispatchEvent(mark(ev)); } catch (_e) {}
  }
  function moveFocus(target) {
    var prev = focusedElement();
    if (target && prev && sameNode(prev, target)) return true;
    if (prev) {
      try { prev.blur(); } catch (_e) {}
      fireFocusEvent(prev, 'blur', target);
      fireFocusEvent(prev, 'focusout', target);
    }
    if (!target) return true;
    try { target.focus(); } catch (_e) {}
    if (!sameNode(document.activeElement, target)) return false;
    fireFocusEvent(target, 'focus', prev);
    fireFocusEvent(target, 'focusin', prev);
    return true;
  }`;

/** `this` = element. Give it keyboard focus with focus events; returns whether it is now focused. */
const FOCUS_ELEMENT = `function focusElement() {
  ${FOCUS_HELPERS}
  return moveFocus(this);
}`;

/**
 * `this` = clicked element. A mouse press focuses text-entry controls
 * (inputs, textareas, selects, contenteditable). Other elements are left
 * alone: widgets often cancel mousedown to keep focus in their input.
 */
const FOCUS_FOR_CLICK = `function focusForClick() {
  ${FOCUS_HELPERS}
  var el = this;
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  var tag = el.tagName.toLowerCase();
  var target = null;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') target = el;
  else if (tag === 'label') {
    // a label focuses its control
    var id = el.getAttribute('for');
    target = id ? document.getElementById(id) : el.querySelector('input, textarea, select');
    if (target && ['input', 'textarea', 'select'].indexOf(target.tagName.toLowerCase()) < 0) target = null;
  } else { try { target = el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'); } catch (_e) {} }
  if (!target) return false;
  if (target.disabled || target.hasAttribute('disabled')) return false;
  if (target.tagName.toLowerCase() === 'input' && (target.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
  return moveFocus(target);
}`;

/** `this` = element. Describes what kind of control it is and its state (never its value). */
export const FIELD_INFO = `function fieldInfo() {
  ${LABEL_OF}
  var el = this;
  if (!el || el.nodeType !== 1) return { error: 'not an element' };
  if (!el.isConnected) return { error: 'detached' };
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute('type') || '').toLowerCase();
  var role = (el.getAttribute('role') || '').toLowerCase();
  var ce = el.getAttribute('contenteditable');
  var editable = tag !== 'input' && tag !== 'textarea' && (el.isContentEditable === true || ce === '' || ce === 'true' || ce === 'plaintext-only');
  var checkable = (tag === 'input' && (type === 'checkbox' || type === 'radio')) || role === 'checkbox' || role === 'switch' || role === 'radio';
  return {
    nid: el._nid, tag: tag, type: type, role: role, label: labelOf(el),
    name: el.getAttribute('name') || '', id: el.id || '', autocomplete: el.getAttribute('autocomplete') || '',
    editable: editable,
    select: tag === 'select', multiple: tag === 'select' && (el.multiple === true || el.hasAttribute('multiple')),
    checkable: checkable,
    checked: checkable ? (tag === 'input' ? !!el.checked : el.getAttribute('aria-checked') === 'true') : false,
    disabled: !!(el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'),
    readOnly: !!(el.readOnly || el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true'),
    maxLength: (tag === 'input' || tag === 'textarea') && /^\\d+$/.test(el.getAttribute('maxlength') || '') ? parseInt(el.getAttribute('maxlength'), 10) : -1,
    active: !!document.activeElement && (document.activeElement === el || (el._nid !== undefined && document.activeElement._nid === el._nid)),
  };
}`;

/** FIELD_INFO for document.activeElement, or null when nothing (body) is focused. */
const ACTIVE_FIELD_INFO = `function activeFieldInfo() {
  var el = document.activeElement;
  var same = function (a, b) { return !!a && !!b && (a === b || (a._nid !== undefined && a._nid === b._nid)); };
  if (!el || same(el, document.body) || same(el, document.documentElement)) return null;
  return (${FIELD_INFO}).call(el);
}`;

/** `this` = input/textarea. Put the caret at the end; report the value length and whether it has focus. */
const CARET_TO_END = `function caretToEnd() {
  var el = this;
  var len = String(el.value == null ? '' : el.value).length;
  try { el.setSelectionRange(len, len); } catch (_e) {}
  var a = document.activeElement;
  return { length: len, active: !!a && (a === el || (el._nid !== undefined && a._nid === el._nid)) };
}`;

/** `this` = input/textarea. Value length and focus, without the value itself. */
const VALUE_STATE = `function valueState() {
  var a = document.activeElement;
  return { length: String(this.value == null ? '' : this.value).length, active: !!a && (a === this || (this._nid !== undefined && a._nid === this._nid)) };
}`;

/** `this` = field. Current value (or text for contenteditable) for tool output. */
const CURRENT_VALUE = `function currentValue() {
  var tag = this.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return String(this.value == null ? '' : this.value);
  return String(this.textContent || '');
}`;

/**
 * `this` = contenteditable element. Append text at the end like typing with
 * the caret at the end: into the last text node (keeping markup), with
 * beforeinput/input events. SET_VALUE's append would flatten the markup.
 */
const CONTENT_APPEND = `function contentAppend(text) {
  var el = this;
  var mark = globalThis.__obscura_markTrusted || function (e) { return e; };
  var fire = function (type, cancelable) {
    var ev;
    try { ev = new InputEvent(type, { bubbles: true, cancelable: cancelable, composed: true, inputType: 'insertText', data: text }); } catch (_e) { ev = new Event(type, { bubbles: true, cancelable: cancelable }); }
    try { return el.dispatchEvent(mark(ev)); } catch (_e) { return !ev.defaultPrevented; }
  };
  if (!fire('beforeinput', true)) return { prevented: true };
  var walker = document.createTreeWalker(el, 4), last = null;
  while (walker.nextNode()) last = walker.currentNode;
  if (last) last.data = String(last.data) + text;
  else el.appendChild(document.createTextNode(text));
  fire('input', false);
  return { ok: true };
}`;

/** SET_VALUE without echoing the value back (the CDP response is logged). */
const SET_VALUE_SILENT = `function setValueSilent(value, mode) {
  var r = (${SET_VALUE}).call(this, value, mode);
  if (r && typeof r === 'object') delete r.value;
  return r;
}`;

/**
 * Value of the focused text field after a key press, unless it looks like a
 * password field (the regex source arrives as an argument).
 */
const ACTIVE_TEXT_VALUE = `function activeTextValue(sensitiveSource) {
  ${LABEL_OF}
  var el = document.activeElement;
  if (!el || el.nodeType !== 1) return null;
  var tag = el.tagName.toLowerCase();
  var type = (el.getAttribute('type') || '').toLowerCase();
  var ce = el.getAttribute('contenteditable');
  var editable = tag !== 'input' && tag !== 'textarea' && (ce === '' || ce === 'true' || ce === 'plaintext-only');
  var NON_TEXT = ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'hidden'];
  if (!(tag === 'textarea' || editable || (tag === 'input' && NON_TEXT.indexOf(type) < 0))) return null;
  if (type === 'password') return null;
  var ident = (el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + labelOf(el);
  try { if (new RegExp(sensitiveSource, 'i').test(ident)) return null; } catch (_e) { return null; }
  return { value: editable ? String(el.textContent || '') : String(el.value == null ? '' : el.value) };
}`;

const LIST_OPTIONS = `function listOptions() {
  var opts = this.options || [];
  var out = [];
  for (var i = 0; i < opts.length && i < 50; i++) out.push({ value: String(opts[i].value), text: String(opts[i].textContent || '').replace(/\\s+/g, ' ').trim() });
  return { options: out, total: opts.length };
}`;

/**
 * One key press on document.activeElement (or body), like a browser: a
 * trusted keydown (plus keypress for characters and Enter), then, unless a
 * page handler called preventDefault(), the default action. Obscura's own
 * Input.dispatchKeyEvent ignores preventDefault, submits the owning form on
 * Enter from any control (even a type=button button) and has no Tab, Delete,
 * caret or scrolling behaviour, so the whole press is emulated here with the
 * same event construction Obscura uses.
 *
 * Returns the effect; 'activate' asks the server to click the element with
 * real mouse events. keyup is sent separately (KEY_UP).
 */
const KEY_PRESS = `function keyPress(key, code, text, shift, keyCode) {
  ${LABEL_OF}
  ${FOCUS_HELPERS}
  var doc = document, body = doc.body;
  var markTrusted = globalThis.__obscura_markTrusted || function (e) { return e; };
  var setField = globalThis.__obscura_setFieldValue || function (e, f, v) { e[f] = v; };
  var NON_TEXT = ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'hidden'];
  var BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
  var describe = function (n) { return { nid: n._nid, tag: n.tagName.toLowerCase(), type: (n.getAttribute('type') || '').toLowerCase(), label: labelOf(n) }; };
  var dispatch = function (target, ev) {
    try { return target.dispatchEvent(markTrusted(ev)); } catch (_e) { return !ev.defaultPrevented; }
  };
  // A KeyboardEvent constructed with { keyCode } ignores it (the spec makes keyCode/which/charCode 0
  // on synthetic events), yet many handlers still gate on e.keyCode===13 etc. (classic TodoMVC), so
  // the legacy numbers are defined back onto each event.
  var kc = keyCode || 0;
  var keyEvent = function (type) {
    var ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key: key, code: code, shiftKey: !!shift });
    try {
      Object.defineProperty(ev, 'keyCode', { configurable: true, get: function () { return kc; } });
      Object.defineProperty(ev, 'which', { configurable: true, get: function () { return kc; } });
      if (type === 'keypress') {
        var cc = (text !== null && text !== undefined && text.length) ? text.charCodeAt(0) : kc;
        Object.defineProperty(ev, 'charCode', { configurable: true, get: function () { return cc; } });
      }
    } catch (_e) {}
    return ev;
  };
  var keyboard = function (type) {
    return dispatch(doc.activeElement || body, keyEvent(type));
  };
  var inputEvent = function (el, type, inputType, data, cancelable) {
    var ev;
    try { ev = new InputEvent(type, { bubbles: true, cancelable: cancelable, composed: true, inputType: inputType, data: data }); } catch (_e) { ev = new Event(type, { bubbles: true, cancelable: cancelable }); }
    return dispatch(el, ev);
  };
  var fireScroll = function () {
    try { doc.dispatchEvent(markTrusted(new Event('scroll', { bubbles: true }))); } catch (_e) {}
    try { window.dispatchEvent(markTrusted(new Event('scroll'))); } catch (_e) {}
  };

  if (!keyboard('keydown')) return { effect: 'prevented', phase: 'keydown' };
  if (text !== null && text !== undefined && !keyboard('keypress')) return { effect: 'prevented', phase: 'keypress' };

  var el = focusedElement();
  var onBody = !el;
  var tag = onBody ? '' : el.tagName.toLowerCase();
  var type = onBody ? '' : (el.getAttribute('type') || '').toLowerCase();
  var ce = onBody ? null : el.getAttribute('contenteditable');
  var editable = !onBody && tag !== 'input' && tag !== 'textarea' && (el.isContentEditable === true || ce === '' || ce === 'true' || ce === 'plaintext-only');
  var textField = tag === 'textarea' || (tag === 'input' && NON_TEXT.indexOf(type) < 0);
  var disabled = !onBody && !!(el.disabled || el.hasAttribute('disabled'));
  var readOnly = !onBody && !!(el.readOnly || el.hasAttribute('readonly'));
  var writable = textField && !disabled && !readOnly;

  // insert (ins !== null) or delete (ins === null) at the caret of a text field
  var edit = function (inputType, ins, backward) {
    var v = String(el.value == null ? '' : el.value);
    var s = el.selectionStart, e = el.selectionEnd;
    if (typeof s !== 'number') s = v.length;
    if (typeof e !== 'number') e = s;
    s = Math.max(0, Math.min(s, v.length)); e = Math.max(0, Math.min(e, v.length));
    var lo = Math.min(s, e), hi = Math.max(s, e);
    if (ins === null) {
      if (lo === hi) {
        if (backward) { if (lo === 0) return { effect: 'none' }; lo--; }
        else { if (hi >= v.length) return { effect: 'none' }; hi++; }
      }
    } else {
      var max = /^\\d+$/.test(el.getAttribute('maxlength') || '') ? parseInt(el.getAttribute('maxlength'), 10) : -1;
      if (max >= 0 && v.length - (hi - lo) + ins.length > max) return { effect: 'none', full: true };
    }
    if (!inputEvent(el, 'beforeinput', inputType, ins, true)) return { effect: 'prevented', phase: 'beforeinput' };
    setField(el, 'value', v.slice(0, lo) + (ins || '') + v.slice(hi));
    var caret = lo + (ins ? ins.length : 0);
    try { el.setSelectionRange(caret, caret); } catch (_e) {}
    inputEvent(el, 'input', inputType, ins, false);
    return ins === null ? { effect: 'delete', count: hi - lo } : { effect: 'insert' };
  };

  // HTML implicit submission: click the form's default button, or submit a form with a single text field
  var implicitSubmit = function (canTrigger) {
    var form = el.form || (el.closest ? el.closest('form') : null);
    if (!form) return { effect: 'none' };
    var controls = form.querySelectorAll('button, input');
    var dflt = null, blockers = 0;
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i], ct = c.tagName.toLowerCase(), ty = (c.getAttribute('type') || '').toLowerCase();
      if (!dflt && ((ct === 'button' && (ty === '' || ty === 'submit')) || (ct === 'input' && (ty === 'submit' || ty === 'image')))) dflt = c;
      if (ct === 'input' && NON_TEXT.indexOf(ty) < 0) blockers++;
    }
    if (dflt) {
      if (dflt.disabled || dflt.hasAttribute('disabled')) return { effect: 'none', reason: 'default-disabled', element: describe(dflt) };
      if (!dispatch(dflt, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }))) return { effect: 'prevented', phase: 'click' };
      try { form.requestSubmit(dflt); } catch (_e) { form.requestSubmit(); }
      return { effect: 'submit', element: describe(dflt) };
    }
    if (!canTrigger) return { effect: 'none' };
    if (blockers > 1) return { effect: 'none', reason: 'no-default-button' };
    form.requestSubmit();
    return { effect: 'submit' };
  };

  if (key === 'Tab') {
    var all = doc.querySelectorAll('a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    var cands = [], groups = {};
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var ti = parseInt(c.getAttribute('tabindex'), 10);
      if (isNaN(ti)) ti = 0;
      if (ti < 0) continue;
      if (c.disabled || c.hasAttribute('disabled')) continue;
      var ctag = c.tagName.toLowerCase(), ctype = (c.getAttribute('type') || '').toLowerCase();
      if (ctag === 'input' && ctype === 'hidden') continue;
      try { if (c.closest('[inert], fieldset[disabled]')) continue; } catch (_e) {}
      var r = c.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      try { var cs = getComputedStyle(c); if (cs.visibility === 'hidden' || cs.display === 'none') continue; } catch (_e) {}
      var cand = { el: c, ti: ti, i: i };
      var name = ctag === 'input' && ctype === 'radio' ? c.getAttribute('name') : null;
      if (name) {
        // a radio group is a single tab stop: the focused, checked, or first/last radio
        var owner = c.form || (c.closest ? c.closest('form') : null);
        var gk = name + '|' + (owner && owner._nid !== undefined ? owner._nid : '');
        var g = groups[gk] || (groups[gk] = { first: null, last: null, checked: null, focused: null });
        if (!g.first) g.first = cand;
        g.last = cand;
        if (c.checked && !g.checked) g.checked = cand;
        if (sameNode(c, el)) g.focused = cand;
        cand.group = g;
      }
      cands.push(cand);
    }
    cands = cands.filter(function (x) { return !x.group || x === (x.group.focused || x.group.checked || (shift ? x.group.last : x.group.first)); });
    if (!cands.length) return { effect: 'none' };
    cands.sort(function (a, b) { return (a.ti > 0 ? a.ti : 1e9) - (b.ti > 0 ? b.ti : 1e9) || a.i - b.i; });
    var idx = -1;
    for (var k = 0; k < cands.length; k++) if (sameNode(cands[k].el, el)) { idx = k; break; }
    if (idx < 0 && !onBody && typeof el.compareDocumentPosition === 'function') {
      // focus is on an element outside the tab order: continue from its document position
      for (var m = 0; m < cands.length; m++) {
        if (el.compareDocumentPosition(cands[m].el) & 4) { idx = shift ? m : m - 1; break; }
      }
      if (idx < 0) idx = shift ? cands.length : cands.length - 1;
    }
    var next = shift ? (idx <= 0 ? cands.length - 1 : idx - 1) : (idx + 1) % cands.length;
    var target = cands[next].el;
    if (!moveFocus(target)) return { effect: 'none' };
    return { effect: 'focus', element: describe(target) };
  }

  if (key === 'Enter') {
    if (onBody || disabled) return { effect: 'none' };
    if (tag === 'textarea') return readOnly ? { effect: 'none' } : edit('insertLineBreak', '\\n', false);
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return { effect: 'activate', element: describe(el) };
    if (tag === 'button' || tag === 'summary' || (tag === 'input' && BUTTON_TYPES.indexOf(type) >= 0)) return { effect: 'activate', element: describe(el) };
    if (tag === 'select' || (tag === 'input' && type !== 'file')) return implicitSubmit(tag === 'input' && textField);
    return { effect: 'none' };
  }

  if (text !== null && text !== undefined) {
    // a printable character (or Space)
    if (writable) return edit('insertText', text, false);
    if (editable) {
      if (!inputEvent(el, 'beforeinput', 'insertText', text, true)) return { effect: 'prevented', phase: 'beforeinput' };
      var walker = doc.createTreeWalker(el, 4), last = null;
      while (walker.nextNode()) last = walker.currentNode;
      if (last) last.data = String(last.data) + text;
      else el.appendChild(doc.createTextNode(text));
      inputEvent(el, 'input', 'insertText', text, false);
      return { effect: 'insert' };
    }
    if (key === ' ' && !onBody && !disabled && (tag === 'button' || tag === 'summary' || (tag === 'input' && ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].indexOf(type) >= 0))) {
      return { effect: 'activate', element: describe(el) };
    }
    if (key !== ' ' || textField || editable) return { effect: 'none' };
  }

  if (key === 'Backspace' || key === 'Delete') return writable ? edit(key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward', null, key === 'Backspace') : { effect: 'none' };

  if (textField && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(key) >= 0) {
    var v = String(el.value == null ? '' : el.value);
    var s = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
    var e = typeof el.selectionEnd === 'number' ? el.selectionEnd : s;
    var multiline = tag === 'textarea';
    var pos;
    if (key === 'ArrowLeft') pos = s !== e ? Math.min(s, e) : Math.max(0, s - 1);
    else if (key === 'ArrowRight') pos = s !== e ? Math.max(s, e) : Math.min(v.length, e + 1);
    else if (key === 'Home' || (key === 'ArrowUp' && !multiline)) pos = multiline && s > 0 ? v.lastIndexOf('\\n', s - 1) + 1 : 0;
    else if (key === 'End' || (key === 'ArrowDown' && !multiline)) { var nl = multiline ? v.indexOf('\\n', e) : -1; pos = nl < 0 ? v.length : nl; }
    else return { effect: 'none' };
    try { el.setSelectionRange(pos, pos); } catch (_e) { return { effect: 'none' }; }
    return { effect: 'caret', position: pos, length: v.length };
  }

  var scrollKeys = { PageDown: 1, PageUp: 1, Home: 1, End: 1, ' ': 1, ArrowDown: 1, ArrowUp: 1, ArrowLeft: 1, ArrowRight: 1 };
  if (scrollKeys[key] && !textField && !editable && tag !== 'select' && !(tag === 'input' && type === 'radio')) {
    var h = window.innerHeight || 720;
    var se = doc.scrollingElement || doc.documentElement || body;
    var pageHeight = Math.max(se ? se.scrollHeight : 0, body ? body.scrollHeight : 0);
    var page = Math.max(40, Math.round(h * 0.875));
    var x0 = window.scrollX, y0 = window.scrollY;
    switch (key) {
      case 'PageDown': window.scrollBy(0, page); break;
      case 'PageUp': window.scrollBy(0, -page); break;
      case ' ': window.scrollBy(0, shift ? -page : page); break;
      case 'Home': window.scrollTo(x0, 0); break;
      case 'End': window.scrollTo(x0, pageHeight); break;
      case 'ArrowDown': window.scrollBy(0, 40); break;
      case 'ArrowUp': window.scrollBy(0, -40); break;
      case 'ArrowLeft': window.scrollBy(-40, 0); break;
      case 'ArrowRight': window.scrollBy(40, 0); break;
    }
    var x1 = Math.round(window.scrollX), y1 = Math.round(window.scrollY);
    var moved = x1 !== Math.round(x0) || y1 !== Math.round(y0);
    if (moved) fireScroll();
    return { effect: 'scroll', x: x1, y: y1, moved: moved, maxY: Math.max(0, pageHeight - h), pageHeight: pageHeight, viewportHeight: h };
  }
  return { effect: 'none' };
}`;

const KEY_UP = `function keyUp(key, code, shift, keyCode) {
  var mark = globalThis.__obscura_markTrusted || function (e) { return e; };
  var target = document.activeElement || document.body;
  var kc = keyCode || 0;
  try {
    var ev = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: key, code: code, shiftKey: !!shift });
    try {
      Object.defineProperty(ev, 'keyCode', { configurable: true, get: function () { return kc; } });
      Object.defineProperty(ev, 'which', { configurable: true, get: function () { return kc; } });
    } catch (_e) {}
    target.dispatchEvent(mark(ev));
  } catch (_e) {}
  return true;
}`;

// ====================================================================== shared helpers

export interface FieldInfo {
  nid: number;
  tag: string;
  type: string;
  role: string;
  label: string;
  name: string;
  id: string;
  autocomplete: string;
  editable: boolean;
  select: boolean;
  multiple: boolean;
  checkable: boolean;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** maxlength attribute of inputs/textareas, -1 when absent. */
  maxLength: number;
  active: boolean;
  error?: string;
}

export interface PreparedElement {
  box: ElementBox;
  info: FieldInfo;
}

const NOT_FILLABLE_INPUT = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file']);
const TYPEABLE_INPUT = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number']);
export const SENSITIVE_FIELD = /pass(word)?|passwd|pwd|secret|token|otp|one-time|\bpin\b|cvv|cvc|csc|card-?number|cc-?(num|number)/i;

/** Scroll the element into view, measure it and describe the control. */
export async function inspectElement(tab: Tab, handle: ElementHandle): Promise<PreparedElement> {
  const box = await measure(tab, handle);
  const info = await tab.callFunction<FieldInfo>(FIELD_INFO, [], { objectId: handle.objectId });
  if (!info || info.error) {
    if (handle.ref) throw new StaleRefError(handle.ref);
    throw new ToolError(`Element ${handle.target} is no longer attached to the page`);
  }
  return { box, info };
}

function kindOf(info: Pick<FieldInfo, 'tag' | 'type'> & Partial<Pick<FieldInfo, 'role' | 'editable'>>): string {
  if (info.type) return `${info.tag}[${info.type}]`;
  if (info.editable) return `${info.tag}[contenteditable]`;
  if (info.role) return `${info.tag}[role=${info.role}]`;
  return info.tag;
}

/** e.g. `input[email] "Email address" (ref e3)` */
export function describeField(info: FieldInfo, handle: ElementHandle): string {
  return `${kindOf(info)}${info.label ? ` ${JSON.stringify(info.label)}` : ''} (${handle.target})`;
}

/** Password-like fields: their values are never echoed and never sent through logged CDP commands. */
export function isSensitiveField(info: Pick<FieldInfo, 'type' | 'name' | 'id' | 'autocomplete' | 'label'>): boolean {
  return info.type === 'password' || SENSITIVE_FIELD.test(`${info.name} ${info.id} ${info.autocomplete} ${info.label}`);
}

function quoteValue(value: string, max = 100): string {
  const chars = Array.from(value);
  return chars.length <= max ? JSON.stringify(value) : `${JSON.stringify(chars.slice(0, max).join(''))}…(${chars.length} chars)`;
}

function charCount(value: string): string {
  const n = Array.from(value).length;
  return `(${n} character${n === 1 ? '' : 's'})`;
}

/**
 * Runtime.callFunctionOn that can skip the outgoing debug log, used when the
 * arguments carry a secret. The function must not return the secret either,
 * because responses are logged.
 */
async function callOn<T>(tab: Tab, fn: string, args: unknown[], objectId: string | undefined, quiet: boolean): Promise<T> {
  if (!quiet) return tab.callFunction<T>(fn, args, { objectId });
  const params: Record<string, unknown> = {
    functionDeclaration: fn,
    arguments: args.map((value) => (value === undefined ? {} : { value })),
    returnByValue: true,
    awaitPromise: false,
    userGesture: true,
    timeout: 30_000,
  };
  if (objectId) params.objectId = objectId;
  const res = await tab.send<{ result: RemoteObject; exceptionDetails?: any }>('Runtime.callFunctionOn', params, 35_000, true);
  if (res.exceptionDetails) throw new JavaScriptError(describeException(res.exceptionDetails));
  return res.result.value as T;
}

/** Give the element keyboard focus, firing blur/focus events (Obscura's focus() fires none). */
export async function focusElement(tab: Tab, handle: ElementHandle): Promise<void> {
  try {
    if (await tab.callFunction<boolean>(FOCUS_ELEMENT, [], { objectId: handle.objectId })) return;
  } catch (err) {
    if (!(err instanceof JavaScriptError)) throw err;
  }
  try {
    await tab.send('DOM.focus', { objectId: handle.objectId });
  } catch (err) {
    if (!(err instanceof CdpError)) throw err;
  }
}

function assertEditable(info: FieldInfo, desc: string, tool: 'browser_fill' | 'browser_type'): void {
  if (info.checkable) throw new ToolError(`${desc} is a ${info.type === 'radio' || info.role === 'radio' ? 'radio button' : 'checkbox'}; use browser_check instead of ${tool}`);
  if (info.tag === 'input' && info.type === 'file') throw new ToolError(`${desc} is a file input; file uploads are not supported`);
  const fillable = info.tag === 'textarea' || info.editable || (info.tag === 'input' && !NOT_FILLABLE_INPUT.has(info.type));
  if (!fillable) {
    throw new ToolError(`${desc} is not a text field (input, textarea or contenteditable element); use browser_click for buttons and links`);
  }
  if (info.disabled) throw new ToolError(`${desc} is disabled`);
  if (info.readOnly) throw new ToolError(`${desc} is read-only`);
}

interface SetValueResult {
  ok?: boolean;
  error?: string;
  value?: string | null;
}

/**
 * Replace the value of a text field, textarea, contenteditable element or
 * select (by option value or text). Returns a one-line summary. Callers wrap
 * it in tab.trackNavigation(): change handlers may navigate.
 */
export async function fillElement(ctx: ToolContext, tab: Tab, handle: ElementHandle, value: string, prepared?: PreparedElement): Promise<string> {
  const { box, info } = prepared ?? (await inspectElement(tab, handle));
  if (info.select) return selectOptions(ctx, tab, handle, [value], { box, info });
  const desc = describeField(info, handle);
  assertEditable(info, desc, 'browser_fill');
  const sensitive = isSensitiveField(info);
  if (sensitive) ctx.markSensitive();
  const quiet = sensitive && ctx.config.log.redactSecrets;

  // like pasting: a browser keeps at most maxlength characters
  const limited = info.maxLength >= 0 && value.length > info.maxLength;
  const finalValue = limited ? value.slice(0, info.maxLength) : value;
  const note = limited ? ` (truncated to maxlength ${info.maxLength})` : '';

  if (box.visible) ctx.pointer(tab, box.x, box.y, 'type', info.label);
  await focusElement(tab, handle);
  const res = await callOn<SetValueResult>(tab, quiet ? SET_VALUE_SILENT : SET_VALUE, [finalValue, 'replace'], handle.objectId, quiet);
  if (!res || res.error) throw new ToolError(`Cannot fill ${desc}: ${res?.error ?? 'unknown error'}`);

  if (sensitive) return `Filled ${desc} with ${charCount(finalValue)}${note}`;
  let text = `Filled ${desc} with ${quoteValue(finalValue)}${note}`;
  if (typeof res.value === 'string' && res.value !== finalValue) text += `; the field now contains ${quoteValue(res.value)}`;
  return text;
}

/**
 * Append text at the end of a field like a user typing: focus, caret to the
 * end, Input.insertText (fires input events). Falls back to a scripted append
 * for contenteditable elements or when focus could not be put on the field.
 */
export async function typeIntoElement(ctx: ToolContext, tab: Tab, handle: ElementHandle, text: string): Promise<{ summary: string; info: FieldInfo }> {
  const { box, info } = await inspectElement(tab, handle);
  const desc = describeField(info, handle);
  if (info.select) throw new ToolError(`${desc} is a <select>; use browser_select_option`);
  assertEditable(info, desc, 'browser_type');
  const sensitive = isSensitiveField(info);
  if (sensitive) ctx.markSensitive();
  const quiet = sensitive && ctx.config.log.redactSecrets;

  if (box.visible) ctx.pointer(tab, box.x, box.y, 'type', info.label);
  await focusElement(tab, handle);

  const navSeq = tab.navSeq;
  let typed = false;
  let toType = text;
  let note = '';
  const keyboardCapable = info.tag === 'textarea' || (info.tag === 'input' && TYPEABLE_INPUT.has(info.type));
  if (!info.editable && keyboardCapable && text.length > 0) {
    const before = await tab.callFunction<{ length: number; active: boolean }>(CARET_TO_END, [], { objectId: handle.objectId });
    // a browser stops accepting typed characters at maxlength (Obscura does not enforce it)
    if (info.maxLength >= 0 && before.length + text.length > info.maxLength) {
      toType = text.slice(0, Math.max(0, info.maxLength - before.length));
      note = ` (maxlength ${info.maxLength}: ${toType.length ? `only ${charCount(toType).slice(1, -1)} fit` : 'the field is full'})`;
    }
    // Input.insertText types into document.activeElement: only use it when focus really is on the target.
    if (before.active && toType.length > 0) {
      await tab.send('Input.insertText', { text: toType }, undefined, quiet);
      if (tab.navSeq !== navSeq) {
        typed = true;
      } else {
        // The insertion happened if the length changed or the field still has focus (an input handler may
        // have rewritten or cleared the value). Only fall back when focus was lost, to avoid typing twice.
        const after = await tab.callFunction<{ length: number; active: boolean }>(VALUE_STATE, [], { objectId: handle.objectId });
        typed = after.length !== before.length || after.active;
      }
    }
  }
  if (!typed && toType.length > 0 && info.editable) {
    const res = await callOn<{ ok?: boolean; prevented?: boolean }>(tab, CONTENT_APPEND, [toType], handle.objectId, quiet);
    if (res?.prevented) note += ' (the page cancelled the input, so nothing was inserted)';
  } else if (!typed && toType.length > 0) {
    const res = await callOn<SetValueResult>(tab, quiet ? SET_VALUE_SILENT : SET_VALUE, [toType, 'append'], handle.objectId, quiet);
    if (!res || res.error) throw new ToolError(`Cannot type into ${desc}: ${res?.error ?? 'unknown error'}`);
  }

  const verb = text.length > 0 && toType.length === 0 ? 'Typed nothing' : `Typed ${sensitive ? charCount(toType) : quoteValue(toType)}`;
  if (sensitive || tab.navSeq !== navSeq) return { summary: `${verb} into ${desc}${note}`, info };
  const now = await tab.callFunction<string>(CURRENT_VALUE, [], { objectId: handle.objectId });
  return { summary: `${verb} into ${desc}${note}; the field now contains ${quoteValue(now ?? '')}`, info };
}

interface SelectResult {
  ok?: boolean;
  error?: string;
  selected?: Array<{ value: string; text: string }>;
  option?: { value: string; text: string };
}

/** Select option(s) of a <select> by value, exact text or case-insensitive text. */
export async function selectOptions(ctx: ToolContext, tab: Tab, handle: ElementHandle, wanted: string[], prepared?: PreparedElement): Promise<string> {
  const { box, info } = prepared ?? (await inspectElement(tab, handle));
  const desc = describeField(info, handle);
  if (!info.select) {
    throw new ToolError(`${desc} is not a <select> element. For a custom dropdown, open it with browser_click and click the option.`);
  }
  if (wanted.length === 0) throw new ToolError('Provide the option to select in value (or values for a multi-select)');
  if (info.disabled) throw new ToolError(`${desc} is disabled`);
  if (wanted.length > 1 && !info.multiple) throw new ToolError(`${desc} allows only one selection; pass a single value`);

  if (box.visible) ctx.pointer(tab, box.x, box.y, 'click', info.label);
  await focusElement(tab, handle);
  const res = await tab.callFunction<SelectResult>(SELECT_OPTION, [wanted], { objectId: handle.objectId });
  if (!res || res.error) {
    const message = res?.error ?? 'unknown error';
    if (/^Option disabled: /.test(message) && res?.option) {
      throw new ToolError(`Option ${formatOption(res.option)} is disabled in ${desc} and cannot be selected`);
    }
    if (/^Option not found: /.test(message)) {
      const missing = message.replace(/^Option not found: /, '');
      const { options, total } = await tab.callFunction<{ options: Array<{ value: string; text: string }>; total: number }>(LIST_OPTIONS, [], {
        objectId: handle.objectId,
      });
      const list = options.map((o) => formatOption(o)).join(', ');
      const more = total > options.length ? `, …${total - options.length} more` : '';
      throw new ToolError(`Option ${JSON.stringify(missing)} not found in ${desc}. Available options: ${list || '(none)'}${more}`);
    }
    throw new ToolError(`Cannot select in ${desc}: ${message}`);
  }
  const chosen = (res.selected ?? []).map((o) => formatOption(o)).join(', ');
  return `Selected ${chosen} in ${desc}`;
}

export function formatOption(o: { value: string; text: string }): string {
  return o.text === o.value ? JSON.stringify(o.text) : `${JSON.stringify(o.text)} (value ${o.value})`;
}

interface CheckResult {
  ok?: boolean;
  error?: string;
  changed?: boolean;
  checked?: boolean;
  /** false when a controlled component reverted the state after it was set. */
  stuck?: boolean;
}

/**
 * Read the checked state after a frame (rAF + macrotask). A React-controlled input reverts a raw
 * .checked change on its next render, so an immediate read would wrongly report success. Returns a
 * Promise; call with awaitPromise=true.
 */
const READ_CHECKED = `function readChecked() {
  var el = this;
  var read = function () { return el.tagName === 'INPUT' ? !!el.checked : el.getAttribute('aria-checked') === 'true'; };
  return new Promise(function (resolve) {
    var done = function () { resolve(read()); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(done, 0); });
    else setTimeout(done, 0);
  });
}`;

/**
 * Check or uncheck a checkbox / radio / role=checkbox. Idempotent. Uses a real
 * click when possible (frameworks listen for click), then verifies and forces
 * the state if the click did not change it.
 */
export async function setCheckedState(ctx: ToolContext, tab: Tab, handle: ElementHandle, checked: boolean, prepared?: PreparedElement): Promise<string> {
  const { box, info } = prepared ?? (await inspectElement(tab, handle));
  const desc = describeField(info, handle);
  if (!info.checkable) {
    throw new ToolError(`${desc} is not a checkbox or radio button. Use browser_click for custom toggles.`);
  }
  const isRadio = info.type === 'radio' || info.role === 'radio';
  if (isRadio && !checked) {
    throw new ToolError(`${desc} is a radio button and cannot be unchecked directly; check another option of the same group instead`);
  }
  if (info.disabled) throw new ToolError(`${desc} is disabled`);
  const verb = checked ? 'Checked' : 'Unchecked';
  if (info.checked === checked) return `${desc} was already ${checked ? 'checked' : 'unchecked'}`;

  let method = '';
  const navSeq = tab.navSeq;
  if (box.visible && box.hitsSelf) {
    ctx.pointer(tab, box.x, box.y, 'click', info.label);
    await mouseClick(tab, box.x, box.y, 1, handle.objectId);
  } else {
    await tab.callFunction('function(){ this.click(); }', [], { objectId: handle.objectId });
    method = ' using a programmatic click';
  }
  // the click navigated: the old element is gone
  if (tab.navSeq !== navSeq) return `${verb} ${desc}${method}`;
  let now: boolean;
  try {
    // read after a frame: a click on a controlled component can toggle .checked and then revert it
    now = await tab.callFunction<boolean>(READ_CHECKED, [], { objectId: handle.objectId, awaitPromise: true });
  } catch (err) {
    // the click replaced the element
    if (err instanceof JavaScriptError || err instanceof CdpError) return `${verb} ${desc}${method}`;
    throw err;
  }
  if (now !== checked) {
    const res = await tab.callFunction<CheckResult>(SET_CHECKED, [checked], { objectId: handle.objectId, awaitPromise: true });
    if (!res || res.error) throw new ToolError(`Cannot ${checked ? 'check' : 'uncheck'} ${desc}: ${res?.error ?? 'unknown error'}`);
    if (res.checked !== checked || res.stuck === false) throw new ToolError(`${desc} did not become ${checked ? 'checked' : 'unchecked'}; the page may be preventing it`);
    method = ' (set directly because clicking did not change it)';
  }
  return `${verb} ${desc}${method}`;
}

// ====================================================================== keys

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** Text the key produces; keys with text also fire keypress. */
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  space: 'Space',
  spacebar: 'Space',
};

const PUNCTUATION_CODES: Record<string, string> = {
  '-': 'Minus', _: 'Minus', '=': 'Equal', '+': 'Equal', '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
  '\\': 'Backslash', '|': 'Backslash', ';': 'Semicolon', ':': 'Semicolon', "'": 'Quote', '"': 'Quote', ',': 'Comma', '<': 'Comma',
  '.': 'Period', '>': 'Period', '/': 'Slash', '?': 'Slash', '`': 'Backquote', '~': 'Backquote',
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
};

const SUPPORTED_KEYS = 'Enter, Tab, Shift+Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, or a single printable character';

export interface ParsedKey {
  def: KeyDef;
  shift: boolean;
  /** For output, e.g. `Enter`, `Shift+Tab`, `"a"`. */
  label: string;
}

function printableKey(ch: string): KeyDef {
  let code = '';
  if (/^[a-z]$/i.test(ch)) {
    code = `Key${ch.toUpperCase()}`;
  } else if (/^[0-9]$/.test(ch)) {
    code = `Digit${ch}`;
  } else {
    code = PUNCTUATION_CODES[ch] ?? '';
  }
  // legacy keyCode is the upper-cased character code, so keyCode-based handlers (e.g. e.keyCode===13) work
  const keyCode = ch.toUpperCase().charCodeAt(0) || 0;
  return { key: ch, code, keyCode, text: ch };
}

/** Parse an agent-supplied key name. Modifier combinations are rejected (Obscura ignores modifiers). */
export function parseKey(input: string): ParsedKey {
  if (typeof input !== 'string' || input.length === 0) throw new ToolError(`Provide a key to press: ${SUPPORTED_KEYS}`);
  if (input === ' ') return { def: NAMED_KEYS.Space!, shift: false, label: 'Space' };
  if (input === '\n' || input === '\r' || input === '\r\n') return { def: NAMED_KEYS.Enter!, shift: false, label: 'Enter' };
  if (input === '\t') return { def: NAMED_KEYS.Tab!, shift: false, label: 'Tab' };
  if (Array.from(input).length === 1) {
    if (/\p{Cc}/u.test(input)) throw new ToolError(`Unsupported control character ${JSON.stringify(input)}. Supported keys: ${SUPPORTED_KEYS}.`);
    return { def: printableKey(input), shift: false, label: JSON.stringify(input) };
  }

  const trimmed = input.trim();
  const combo = /^(shift|ctrl|control|alt|option|opt|meta|cmd|command|super|win|windows)\s*\+\s*(.+)$/i.exec(trimmed);
  if (combo) {
    const modifier = combo[1]!.toLowerCase();
    const rest = combo[2]!;
    if (modifier === 'shift') {
      const named = KEY_ALIASES[rest.trim().toLowerCase()];
      if (named === 'Tab') return { def: NAMED_KEYS.Tab!, shift: true, label: 'Shift+Tab' };
      if (named === 'Space') return { def: NAMED_KEYS.Space!, shift: true, label: 'Shift+Space' };
      if (/^[a-z]$/i.test(rest)) {
        const upper = rest.toUpperCase();
        return { def: printableKey(upper), shift: true, label: JSON.stringify(upper) };
      }
      throw new ToolError(
        `"${trimmed}" is not supported: the browser ignores modifier keys. To type a shifted character, pass the character itself (e.g. "A" or "!"); Shift+Tab is supported.`,
      );
    }
    throw new ToolError(
      `Key combinations such as "${trimmed}" are not supported: the browser ignores modifier keys (Control, Alt, Meta). ` +
        'Use browser_fill to replace a field\'s text (instead of select-all), browser_type to add text, browser_snapshot to read text (instead of copy), ' +
        `or press single keys: ${SUPPORTED_KEYS}.`,
    );
  }
  const name = KEY_ALIASES[trimmed.toLowerCase()];
  if (!name) throw new ToolError(`Unsupported key ${JSON.stringify(input)}. Supported keys: ${SUPPORTED_KEYS}. To type text use browser_type.`);
  const def = NAMED_KEYS[name]!;
  return { def, shift: false, label: name };
}

type KeyEffect =
  | { effect: 'none'; full?: boolean; reason?: string; element?: ActiveElement }
  | { effect: 'prevented'; phase: string }
  | { effect: 'insert' }
  | { effect: 'focus' | 'activate'; element: ActiveElement }
  | { effect: 'submit'; element?: ActiveElement }
  | { effect: 'caret'; position: number; length: number }
  | { effect: 'delete'; count: number }
  | { effect: 'scroll'; x: number; y: number; moved: boolean; maxY: number; pageHeight: number; viewportHeight: number };

interface ActiveElement {
  nid: number;
  tag: string;
  type: string;
  label: string;
  role?: string;
  editable?: boolean;
}

/** Keys (besides printable characters) whose effect on a text field is best shown as the resulting value. */
const EDITING_KEYS = new Set(['Backspace', 'Delete', 'Enter']);

/**
 * Press one key on the focused element: keydown/keypress, the default action
 * (see KEY_PRESS; activation of links and buttons uses real mouse events) and
 * keyup. `quiet` keeps the key out of the debug log (typing into a secret field).
 */
export async function dispatchKey(tab: Tab, parsed: ParsedKey, quiet = false): Promise<KeyEffect | null> {
  const { def, shift } = parsed;
  const effect = await callOn<KeyEffect>(tab, KEY_PRESS, [def.key, def.code, def.text ?? null, shift, def.keyCode], undefined, quiet);
  if (effect?.effect === 'activate') {
    try {
      await activateNode(tab, effect.element.nid);
    } catch (err) {
      if (!(err instanceof JavaScriptError || err instanceof CdpError)) throw err;
    }
  }
  try {
    await callOn(tab, KEY_UP, [def.key, def.code, shift, def.keyCode], undefined, quiet);
  } catch (err) {
    // the key press navigated and the old document is gone
    if (!(err instanceof JavaScriptError || err instanceof CdpError)) throw err;
  }
  return effect;
}

/** Keyboard activation (Enter/Space) of a link or button: a real mouse click when possible, else a DOM click. */
async function activateNode(tab: Tab, nid: number): Promise<void> {
  const res = await tab.send<{ object?: RemoteObject }>('DOM.resolveNode', { backendNodeId: nid });
  const objectId = res.object?.objectId;
  if (!objectId) return;
  const box = await tab.callFunction<ElementBox>(ELEMENT_BOX, [true], { objectId });
  if (box.error) return;
  if (box.visible && box.hitsSelf) await mouseClick(tab, box.x, box.y, 1);
  else await tab.callFunction('function(){ this.click(); }', [], { objectId });
}

function describeActive(tab: Tab, el: ActiveElement): string {
  const ref = typeof el.nid === 'number' ? tab.assignRef(el.nid, el.tag, el.label, el.type) : null;
  return `${kindOf(el)}${el.label ? ` ${JSON.stringify(el.label)}` : ''}${ref ? ` (ref ${ref})` : ''}`;
}

function describeKeyEffect(tab: Tab, effect: KeyEffect | null): string {
  if (!effect) return '';
  switch (effect.effect) {
    case 'prevented':
      return `; the page's ${effect.phase} handler prevented the default action`;
    case 'focus':
      return `; focus moved to ${describeActive(tab, effect.element)}`;
    case 'activate':
      return `; activated (clicked) ${describeActive(tab, effect.element)}`;
    case 'submit':
      return effect.element ? `; submitted the form via ${describeActive(tab, effect.element)}` : '; submitted the form';
    case 'caret':
      return `; caret moved to position ${effect.position} of ${effect.length}`;
    case 'delete':
      return `; deleted ${effect.count} character${effect.count === 1 ? '' : 's'}`;
    case 'none':
      if (effect.full) return '; the field is at its maxlength, nothing was inserted';
      if (effect.reason === 'default-disabled' && effect.element) return `; the form was not submitted because its submit button, ${describeActive(tab, effect.element)}, is disabled`;
      if (effect.reason === 'no-default-button') return '; the form was not submitted (it has no submit button and several text fields); click its submit control instead';
      return '';
    case 'scroll': {
      if (!effect.moved) {
        return effect.y >= effect.maxY && effect.maxY > 0 ? '; the page is already at the bottom' : effect.y <= 0 ? '; the page is already at the top' : '';
      }
      let text = `; the page scrolled to y=${effect.y} (page height ${effect.pageHeight}, viewport ${effect.viewportHeight})`;
      if (effect.y >= effect.maxY) text += '. Reached the bottom of the page';
      return text;
    }
    default:
      return '';
  }
}

// ====================================================================== tools

export const fill = defineTool({
  name: 'browser_fill',
  title: 'Fill field',
  group: 'core',
  description:
    'Replace the value of a text input, textarea, contenteditable element or <select> (identified by ref or CSS selector) with the given value. ' +
    'Fires focus, input and change events like a real edit. Use browser_type to append text instead, browser_check for checkboxes/radios, ' +
    'and browser_fill_form to fill several fields at once.',
  inputSchema: z.object({
    ...targetShape,
    value: z.string().describe('The new value; replaces any existing text'),
  }),
  annotations: { ...ACTION, title: 'Fill field' },
  handler: async ({ ref, selector, value }, ctx) => {
    const tab = await ctx.tab();
    const handle = await tab.resolveElement({ ref, selector });
    const outcome = await tab.trackNavigation(() => fillElement(ctx, tab, handle, value));
    return textResult(`${outcome.result}${navigationNote(outcome)}`);
  },
});

export const typeText = defineTool({
  name: 'browser_type',
  title: 'Type text',
  group: 'core',
  description:
    'Type text into a field like a user: focuses it and appends the text at the end of the existing value (use browser_fill to replace the value). ' +
    'Set submit=true to press Enter afterwards, e.g. to run a search or submit a login form; if that navigates, the new page is loaded before returning.',
  inputSchema: z.object({
    ...targetShape,
    text: z.string().describe('Text to type (appended to the current value)'),
    submit: z.boolean().optional().describe('Press Enter after typing (default false)'),
  }),
  annotations: { ...ACTION, title: 'Type text' },
  handler: async ({ ref, selector, text, submit }, ctx) => {
    const tab = await ctx.tab();
    const handle = await tab.resolveElement({ ref, selector });
    const typed = await tab.trackNavigation(() => typeIntoElement(ctx, tab, handle, text));
    const { summary } = typed.result;
    if (typed.navigated) return textResult(`${summary}${submit ? '; Enter was not pressed because typing navigated the page' : ''}${navigationNote(typed)}`);
    if (!submit) return textResult(`${summary}${navigationNote(typed)}`);
    const outcome = await tab.trackNavigation(() => dispatchKey(tab, { def: NAMED_KEYS.Enter!, shift: false, label: 'Enter' }));
    const effect = outcome.navigated ? '' : describeKeyEffect(tab, outcome.result);
    return textResult(`${summary}, then pressed Enter${effect}${navigationNote(outcome)}`);
  },
});

export const pressKey = defineTool({
  name: 'browser_press_key',
  title: 'Press key',
  group: 'core',
  description:
    'Press a single key, optionally on an element (ref or selector) which is focused first; otherwise the key goes to the currently focused element. ' +
    `Supported: ${SUPPORTED_KEYS}. Enter submits the form of a focused field (via its submit button) or activates a focused link/button, ` +
    'Tab/Shift+Tab move focus, Backspace/Delete edit text, PageDown/PageUp/Home/End/Space scroll the page when no text field is focused. ' +
    'The page\'s key handlers run first; if one cancels the key, the result says so. ' +
    'Modifier combinations (Control+A, Meta+C, Alt+…) are not supported because the browser ignores modifier keys. Use browser_type for text.',
  inputSchema: z.object({
    key: z.string().describe('Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown", "PageDown", or one character such as "a"'),
    ...targetShape,
  }),
  annotations: { ...ACTION, title: 'Press key' },
  handler: async ({ key, ref, selector }, ctx) => {
    const parsed = parseKey(key);
    const tab = await ctx.tab();
    let target: string;
    let info: FieldInfo | null;
    // a printable character typed into a password-like field must not be echoed in results, logs or markers
    const labelFor = (field: FieldInfo | null) =>
      field && isSensitiveField(field) && Array.from(parsed.def.key).length === 1 ? 'a character (hidden)' : parsed.label;
    if (ref || selector) {
      const handle = await tab.resolveElement({ ref, selector });
      const prepared = await inspectElement(tab, handle);
      info = prepared.info;
      target = ` on ${describeField(info, handle)}`;
      if (prepared.box.visible) ctx.pointer(tab, prepared.box.x, prepared.box.y, 'key', labelFor(info));
      await focusElement(tab, handle);
    } else {
      info = await tab.callFunction<FieldInfo | null>(ACTIVE_FIELD_INFO);
      target = info ? ` on the focused ${describeActive(tab, info)}` : ' (no element has focus)';
    }
    const keyLabel = labelFor(info);
    if (info && isSensitiveField(info)) ctx.markSensitive();
    const quiet = Boolean(info && isSensitiveField(info) && ctx.config.log.redactSecrets);
    const outcome = await tab.trackNavigation(() => dispatchKey(tab, parsed, quiet));
    let effect = outcome.navigated ? '' : describeKeyEffect(tab, outcome.result);
    const edits = EDITING_KEYS.has(parsed.def.key) || Array.from(parsed.def.key).length === 1;
    // Enter only edits multi-line fields; in an input it submits
    if (!outcome.navigated && info && isTextTarget(info) && edits && !(parsed.def.key === 'Enter' && info.tag === 'input')) {
      const now = await tab.callFunction<{ value: string } | null>(ACTIVE_TEXT_VALUE, [SENSITIVE_FIELD.source]).catch(() => null);
      if (now) effect += `; the field now contains ${quoteValue(now.value)}`;
    }
    return textResult(`Pressed ${keyLabel}${target}${effect}${navigationNote(outcome)}`);
  },
});

function isTextTarget(info: Pick<FieldInfo, 'tag' | 'type' | 'editable'>): boolean {
  return info.tag === 'textarea' || info.editable || (info.tag === 'input' && !NOT_FILLABLE_INPUT.has(info.type) && info.type !== 'range' && info.type !== 'color');
}

export const selectOption = defineTool({
  name: 'browser_select_option',
  title: 'Select option',
  group: 'core',
  description:
    'Choose an option in a <select> dropdown by its value or visible text (case-insensitive). ' +
    'For a multi-select pass values with every option that should end up selected. For custom (non-<select>) dropdowns use browser_click.',
  inputSchema: z.object({
    ...targetShape,
    value: z.string().optional().describe('Option value or visible text to select'),
    values: z.array(z.string()).optional().describe('Several options to select (multi-select only)'),
  }),
  annotations: { ...ACTION, title: 'Select option' },
  handler: async ({ ref, selector, value, values }, ctx) => {
    const wanted = values?.length ? values : value !== undefined ? [value] : [];
    if (wanted.length === 0) throw new ToolError('Provide value (or values for a multi-select)');
    const tab = await ctx.tab();
    const handle = await tab.resolveElement({ ref, selector });
    const outcome = await tab.trackNavigation(() => selectOptions(ctx, tab, handle, wanted));
    return textResult(`${outcome.result}${navigationNote(outcome)}`);
  },
});

export const check = defineTool({
  name: 'browser_check',
  title: 'Check or uncheck',
  group: 'core',
  description:
    'Check or uncheck a checkbox, or select a radio button (ref or CSS selector). Idempotent: reports when it was already in the requested state. ' +
    'Pass checked=false to uncheck a checkbox.',
  inputSchema: z.object({
    ...targetShape,
    checked: z.boolean().optional().describe('true to check (default), false to uncheck'),
  }),
  annotations: { ...ACTION, idempotentHint: true, title: 'Check or uncheck' },
  handler: async ({ ref, selector, checked }, ctx) => {
    const tab = await ctx.tab();
    const handle = await tab.resolveElement({ ref, selector });
    const outcome = await tab.trackNavigation(() => setCheckedState(ctx, tab, handle, checked ?? true));
    return textResult(`${outcome.result}${navigationNote(outcome)}`);
  },
});

interface ScrollResult {
  x: number;
  y: number;
  maxY: number;
  viewportHeight: number;
  pageHeight: number;
}

export const scroll = defineTool({
  name: 'browser_scroll',
  title: 'Scroll',
  group: 'core',
  description:
    'Scroll the page (direction top|bottom|up|down|left|right, default down by one viewport) or scroll an element (ref or selector) into view. ' +
    'Use "bottom" to trigger infinite-scroll loaders, then browser_snapshot to read the new content.',
  inputSchema: z.object({
    direction: z.enum(['top', 'bottom', 'up', 'down', 'left', 'right']).optional().describe('Where to scroll the page (default "down")'),
    amount: z.number().positive().max(1_000_000).optional().describe('Pixels to scroll for up/down/left/right (default one viewport)'),
    ...targetShape,
  }),
  annotations: { ...ACTION, title: 'Scroll' },
  handler: async ({ direction, amount, ref, selector }, ctx) => {
    const tab = await ctx.tab();
    if (ref || selector) {
      const handle = await tab.resolveElement({ ref, selector });
      const box = await measure(tab, handle);
      const info = await tab.pageInfo();
      if (box.visible) ctx.pointer(tab, box.x, box.y, 'scroll', box.label);
      const where = box.visible
        ? `its centre is at x=${Math.round(box.x)}, y=${Math.round(box.y)} in the viewport`
        : 'it is not visible (hidden or zero size)';
      return textResult(`Scrolled ${describeBox(box, handle)} into view; ${where}. Page scroll y=${info.scrollY} (page height ${info.pageHeight}, viewport ${info.innerHeight}).`);
    }
    const dir = direction ?? 'down';
    const res = await tab.callFunction<ScrollResult>(SCROLL_PAGE, [dir, amount ?? null]);
    ctx.pointer(tab, ctx.config.browser.viewport.width / 2, res.viewportHeight / 2, 'scroll', dir);
    const metrics = `page height ${Math.round(res.pageHeight)}, viewport ${res.viewportHeight}`;
    if (dir === 'left' || dir === 'right') return textResult(`Scrolled ${dir} to x=${res.x} (y=${res.y}, ${metrics}).`);
    if (res.maxY <= 0) return textResult(`The page fits in the viewport (${metrics}); nothing to scroll.`);
    if (dir === 'top' || dir === 'bottom') return textResult(`Scrolled to the ${dir}: y=${res.y} (${metrics}).`);
    let text = `Scrolled ${dir} to y=${res.y} (${metrics}).`;
    if (res.y >= res.maxY) text += ' Reached the bottom of the page.';
    else if (res.y <= 0) text += ' At the top of the page.';
    return textResult(text);
  },
});

export default [click, fill, typeText, pressKey, selectOption, check, scroll];
