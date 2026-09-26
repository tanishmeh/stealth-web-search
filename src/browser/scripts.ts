/**
 * JavaScript executed inside pages via `Runtime.callFunctionOn`.
 *
 * Portions adapted from Obscura (https://github.com/h4ckf0r0day/obscura: crates/obscura-mcp and
 * crates/obscura-js/src/markdown.rs), licensed under the Apache License 2.0, and modified for this
 * project. See NOTICE.
 *
 * Every script is a plain function declaration whose inputs arrive as CDP
 * call arguments (JSON-encoded by CDP), never by string interpolation, so
 * agent-supplied selectors/text cannot break out of the script.
 *
 * Stealth notes:
 *  - Nothing here writes to the DOM (no marker attributes) or to window globals.
 *  - Element identity is Obscura's internal node id (`el._nid`), which equals
 *    the CDP backendNodeId, so element references live on the server side.
 *  - Obscura exposes `__obscura_setFieldValue` / `__obscura_markTrusted`
 *    helpers in every realm; scripts use them when present so framework value
 *    trackers (React/Vue) notice changes and events report isTrusted.
 */

/** Visible-ish text of `document.body`, block elements separated by newlines (port of Obscura's extract_text). */
export const EXTRACT_TEXT = `function extractText(rootSelector) {
  var root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return null;
  var BLOCK = {div:1,p:1,h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,li:1,tr:1,br:1,hr:1,section:1,article:1,
    header:1,footer:1,nav:1,main:1,aside:1,blockquote:1,pre:1,ul:1,ol:1,table:1,form:1,fieldset:1,dt:1,dd:1,figure:1,figcaption:1,details:1,summary:1};
  var SKIP = {script:1,style:1,noscript:1,template:1,svg:1,select:1};
  var CELL = {td:1,th:1};
  var isWs = function(c){ return c==='\\t'||c==='\\n'||c==='\\f'||c==='\\r'||c===' '; };
  var result = '', pending = false, visited = 0, NEWLINE = {};
  var stack = [root];
  function append(contents){
    var s = 0, e = contents.length;
    while (s < e && isWs(contents[s])) s++;
    while (e > s && isWs(contents[e-1])) e--;
    var trimmed = contents.slice(s, e);
    if (!trimmed) { for (var i=0;i<contents.length;i++) if (isWs(contents[i])) { pending = true; break; } return; }
    var begins = contents.length > 0 && isWs(contents[0]);
    var endsWs = result.length > 0 && /\\s$/.test(result);
    if ((pending || begins) && result.length > 0 && !endsWs) result += ' ';
    result += trimmed;
    pending = isWs(contents[contents.length-1]);
  }
  while (stack.length) {
    var w = stack.pop();
    if (w === NEWLINE) { result += '\\n'; pending = false; continue; }
    if (++visited > 2000000) break;
    if (w.nodeType === 3) { append(w.data || ''); continue; }
    if (w.nodeType === 1) {
      var tag = (w.localName || '').toLowerCase();
      if (SKIP[tag]) continue;
      if (w.hidden) continue;
      // inline styles are cheap to check; computed styles cost ~0.4 ms per element in Obscura
      var st = w.style;
      if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
      if (BLOCK[tag]) { result += '\\n'; pending = false; stack.push(NEWLINE); }
      // Obscura's layout-free text would glue table cells together ("Espresso€2.50")
      else if (CELL[tag] && w.previousElementSibling) { result += ' | '; pending = false; }
    } else if (w.nodeType !== 9 && w.nodeType !== 11) {
      continue;
    }
    for (var c = w.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return result.replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`;

/**
 * Collect actionable elements. Returns node ids plus a compact description.
 * Visibility is judged from real layout (render build): zero-size boxes,
 * visibility:hidden, and [hidden]/display:none subtrees are skipped unless
 * includeHidden is set.
 */
export const COLLECT_INTERACTIVE = `function collectInteractive(opts) {
  opts = opts || {};
  var sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [role=searchbox], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  var root = opts.rootSelector ? document.querySelector(opts.rootSelector) : document;
  if (!root) return { error: 'root not found' };
  var els = root.querySelectorAll(sel);
  var out = [];
  var total = 0, hidden = 0;
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  function clean(s, n) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, n || 80); }
  function labelFor(e) {
    var t = '';
    var al = e.getAttribute('aria-label');
    if (al) return clean(al);
    var lb = e.getAttribute('aria-labelledby');
    if (lb) {
      var parts = lb.split(/\\s+/).map(function(id){ var n = document.getElementById(id); return n ? (n.textContent || '') : ''; });
      t = clean(parts.join(' '));
      if (t) return t;
    }
    var tag = e.tagName.toLowerCase();
    if ((tag === 'input' || tag === 'select' || tag === 'textarea') && e.id) {
      try {
        var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]');
        if (lab) { t = clean(lab.innerText || lab.textContent); if (t) return t; }
      } catch (_e) {}
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var wrap = e.closest && e.closest('label');
      if (wrap) { t = clean(wrap.innerText || wrap.textContent); if (t) return t; }
    }
    if (tag !== 'select') t = clean(e.innerText || e.textContent);
    if (t) return t;
    var img = e.querySelector && e.querySelector('img[alt]');
    if (img) { t = clean(img.getAttribute('alt')); if (t) return t; }
    // a checkbox/radio has no text of its own; a visible <label> is often its sibling (no for=),
    // or the text lives in the surrounding list item / table row
    var itype = (e.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (itype === 'checkbox' || itype === 'radio')) {
      var sib = e.nextElementSibling;
      if (sib && sib.tagName === 'LABEL' && !sib.getAttribute('for')) { t = clean(sib.innerText || sib.textContent); if (t) return t; }
      var prev = e.previousElementSibling;
      if (prev && prev.tagName === 'LABEL' && !prev.getAttribute('for')) { t = clean(prev.innerText || prev.textContent); if (t) return t; }
      var row = e.closest && e.closest('li, tr, [role=row], [role=listitem]');
      if (row) { t = clean(row.innerText || row.textContent); if (t) return t; }
    }
    return clean(e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('value') || e.getAttribute('name') || '');
  }
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    total++;
    var r = e.getBoundingClientRect();
    var visible = r.width > 0 && r.height > 0;
    if (visible) {
      try { var cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') visible = false; } catch (_e) {}
    }
    if (!visible) { hidden++; if (!opts.includeHidden) continue; }
    if (out.length >= (opts.limit || 100)) continue;
    var tag = e.tagName.toLowerCase();
    var item = {
      nid: e._nid,
      tag: tag,
      type: (e.getAttribute('type') || '').toLowerCase(),
      role: e.getAttribute('role') || '',
      name: e.getAttribute('name') || '',
      label: labelFor(e),
      hints: ((e.id || '') + ' ' + (e.getAttribute('autocomplete') || '')).trim(),
      visible: visible,
      inViewport: visible && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
      disabled: !!(e.disabled || e.getAttribute('aria-disabled') === 'true'),
    };
    if (tag === 'a') item.href = e.href || e.getAttribute('href') || '';
    if (tag === 'input' || tag === 'textarea') {
      var itype = item.type || 'text';
      if (itype === 'checkbox' || itype === 'radio') item.checked = !!e.checked;
      else if (itype !== 'submit' && itype !== 'button' && itype !== 'reset' && itype !== 'image') item.value = itype === 'password' ? (e.value ? '••••' : '') : clean(e.value, 60);
      if (e.getAttribute('placeholder')) item.placeholder = clean(e.getAttribute('placeholder'), 60);
    }
    if (tag === 'select') {
      var opt = e.options && e.options[e.selectedIndex];
      item.value = opt ? clean(opt.textContent, 60) : '';
      var names = [];
      for (var k = 0; e.options && k < e.options.length && k < 12; k++) names.push(clean(e.options[k].textContent, 30));
      item.options = names;
    }
    out.push(item);
  }
  return { elements: out, total: total, hidden: hidden };
}`;

export const DETECT_FORMS = `function detectForms() {
  var forms = document.querySelectorAll('form');
  var out = [];
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    var fields = [];
    var inputs = f.querySelectorAll('input, select, textarea, button');
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j];
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag === 'button' ? 'submit' : tag)).toLowerCase();
      if (tag === 'input' && type === 'hidden') continue;
      var label = '';
      if (el.id) {
        try {
          var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
          if (lab) label = (lab.innerText || lab.textContent || '').trim();
        } catch (_e) {}
      }
      if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (!label && (tag === 'button')) label = (el.innerText || el.textContent || '').trim();
      var opts = null;
      if (tag === 'select') {
        opts = [];
        var os = el.querySelectorAll('option');
        for (var k = 0; k < os.length; k++) opts.push({ value: os[k].value, text: (os[k].textContent || '').trim() });
      }
      fields.push({
        nid: el._nid,
        tag: tag,
        type: type,
        name: el.getAttribute('name') || '',
        hints: ((el.id || '') + ' ' + (el.getAttribute('autocomplete') || '')).trim(),
        value: type === 'password' ? (el.value ? '••••' : '') : (el.value || ''),
        checked: !!el.checked,
        required: el.hasAttribute('required'),
        disabled: !!el.disabled,
        label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 100),
        options: opts,
      });
    }
    out.push({ index: i, id: f.id || '', name: f.getAttribute('name') || '', action: f.action || '', method: (f.getAttribute('method') || 'get').toLowerCase(), fields: fields });
  }
  return out;
}`;

/** Called with `this` = element. Scrolls it into view and returns its viewport box. */
export const ELEMENT_BOX = `function elementBox(scroll) {
  if (!this || this.nodeType !== 1) return { error: 'not an element' };
  if (!this.isConnected) return { error: 'detached' };
  if (scroll) { try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_e) { try { this.scrollIntoView(); } catch (_e2) {} } }
  var r = this.getBoundingClientRect();
  var visible = r.width > 0 && r.height > 0;
  if (visible) { try { var cs = getComputedStyle(this); if (cs.visibility === 'hidden' || cs.display === 'none') visible = false; } catch (_e) {} }
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  var hit = null;
  try { hit = document.elementFromPoint(cx, cy); } catch (_e) {}
  // Obscura hands out distinct wrapper objects for the same node (and contains(self) is false),
  // so compare node identity via the internal node id.
  var same = function(a, b) { return !!a && !!b && (a === b || (a._nid !== undefined && a._nid === b._nid)); };
  var within = function(node, ancestor) { for (var n = node, i = 0; n && i < 10000; n = n.parentNode, i++) if (same(n, ancestor)) return true; return false; };
  var hitsSelf = !!hit && (within(hit, this) || (hit.tagName === 'LABEL' && within(this, hit)));
  var label = (this.innerText || this.textContent || this.getAttribute('aria-label') || this.getAttribute('value') || this.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return {
    x: cx, y: cy, width: r.width, height: r.height, visible: visible, hitsSelf: hitsSelf,
    tag: this.tagName.toLowerCase(), type: (this.getAttribute('type') || '').toLowerCase(), label: label,
    disabled: !!(this.disabled || this.getAttribute('aria-disabled') === 'true'),
    href: this.tagName === 'A' ? (this.href || '') : '',
    obscured: hit && !hitsSelf ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '')) : null,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    scrollX: Math.round(window.scrollX || 0), scrollY: Math.round(window.scrollY || 0),
  };
}`;

/** Called with `this` = element: is it still attached and an element? */
export const IS_LIVE_ELEMENT = `function isLiveElement() { return !!this && this.nodeType === 1 && this.isConnected === true; }`;

export const DESCRIBE_ELEMENT = `function describeElement() {
  var t = this.tagName.toLowerCase();
  var id = this.id ? '#' + this.id : '';
  var name = this.getAttribute('name') ? '[name="' + this.getAttribute('name') + '"]' : '';
  var text = (this.innerText || this.textContent || this.getAttribute('aria-label') || this.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  return t + id + name + (text ? ' "' + text + '"' : '');
}`;

/** `this` = element. Sets a form control value the way a user edit would be observed. */
export const SET_VALUE = `function setValue(value, mode) {
  var el = this;
  var tag = el.tagName.toLowerCase();
  var editable = el.isContentEditable || el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true';
  if (!(tag === 'input' || tag === 'textarea' || tag === 'select' || editable)) return { error: 'Element <' + tag + '> is not a text input, textarea, select or contenteditable element' };
  if (el.disabled) return { error: 'Element is disabled' };
  if (el.readOnly) return { error: 'Element is read-only' };
  var type = (el.getAttribute('type') || '').toLowerCase();
  if (tag === 'input' && ['checkbox','radio','submit','button','reset','image','file'].indexOf(type) >= 0) return { error: 'Input of type "' + type + '" cannot be filled; use browser_click (checkbox/radio) or a dedicated tool' };
  var markTrusted = globalThis.__obscura_markTrusted || function(e){ return e; };
  var setField = globalThis.__obscura_setFieldValue || function(e, f, v){ var p = Object.getPrototypeOf(e), d; while (p && !((d = Object.getOwnPropertyDescriptor(p, f)) && d.set)) p = Object.getPrototypeOf(p); if (d && d.set) d.set.call(e, v); else e[f] = v; };
  try { el.focus(); } catch (_e) {}
  if (editable && tag !== 'input' && tag !== 'textarea') {
    el.textContent = mode === 'append' ? (el.textContent || '') + value : value;
  } else {
    var next = mode === 'append' ? String(el.value || '') + value : value;
    setField(el, 'value', next);
  }
  el.dispatchEvent(markTrusted(new Event('input', { bubbles: true })));
  el.dispatchEvent(markTrusted(new Event('change', { bubbles: true })));
  return { ok: true, value: type === 'password' ? null : (editable && tag !== 'input' && tag !== 'textarea' ? el.textContent : el.value) };
}`;

/**
 * `this` = element (checkbox/radio). Forces the requested state and confirms it stuck.
 *
 * A plain el.click() toggles .checked without firing a change event that React's controlled
 * components see, so they revert the value on their next render. Here the state is set with
 * __obscura_setFieldValue and then a trusted click plus input+change events are dispatched, so
 * framework value trackers and onChange handlers run. The final state is re-read after a macrotask
 * (a frame) so a controlled component's revert is observed and reported via `stuck`.
 * Returns a Promise; call with awaitPromise=true.
 */
export const SET_CHECKED = `function setChecked(checked) {
  var el = this;
  var type = (el.getAttribute('type') || '').toLowerCase();
  if (!(el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) && el.getAttribute('role') !== 'checkbox' && el.getAttribute('role') !== 'switch') return Promise.resolve({ error: 'Element is not a checkbox or radio button' });
  if (el.disabled) return Promise.resolve({ error: 'Element is disabled' });
  var target = !!checked;
  var markTrusted = globalThis.__obscura_markTrusted || function(e){ return e; };
  var setField = globalThis.__obscura_setFieldValue || function(e, f, v){ e[f] = v; };
  var afterFrame = function (read) {
    return new Promise(function (resolve) {
      var done = function () { resolve(read()); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(done, 0); });
      else setTimeout(done, 0);
    });
  };
  if (el.tagName === 'INPUT') {
    var was = !!el.checked;
    setField(el, 'checked', target);
    // a trusted click lets delegated click/onChange handlers run; if the click's default action
    // toggles .checked back, restore it, then fire input+change so value trackers pick up the change
    var clickEv;
    try { clickEv = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }); } catch (_e) { clickEv = new Event('click', { bubbles: true, cancelable: true }); }
    el.dispatchEvent(markTrusted(clickEv));
    if (!!el.checked !== target) setField(el, 'checked', target);
    el.dispatchEvent(markTrusted(new Event('input', { bubbles: true })));
    el.dispatchEvent(markTrusted(new Event('change', { bubbles: true })));
    return afterFrame(function () {
      var now = !!el.checked;
      return { ok: true, changed: was !== now, checked: now, stuck: now === target };
    });
  }
  var cur = el.getAttribute('aria-checked') === 'true';
  if (cur !== target) el.click();
  return afterFrame(function () {
    var now = el.getAttribute('aria-checked') === 'true';
    return { ok: true, changed: cur !== now, checked: now, stuck: now === target };
  });
}`;

/** `this` = <select>. Matches by value, then exact visible text, then case-insensitive text. */
export const SELECT_OPTION = `function selectOption(values) {
  var el = this;
  if (el.tagName !== 'SELECT') return { error: 'Element is not a <select> element' };
  if (el.disabled) return { error: 'Element is disabled' };
  var opts = Array.prototype.slice.call(el.options || []);
  var chosen = [];
  var wanted = Array.isArray(values) ? values : [values];
  var multiple = el.multiple === true || el.hasAttribute('multiple'); // Obscura: el.multiple is undefined
  if (!multiple && wanted.length > 1) return { error: 'This <select> does not allow multiple selections' };
  for (var w = 0; w < wanted.length; w++) {
    var want = String(wanted[w]);
    var match = opts.find(function(o){ return o.value === want; }) ||
      opts.find(function(o){ return (o.textContent || '').trim() === want; }) ||
      opts.find(function(o){ return (o.textContent || '').trim().toLowerCase() === want.trim().toLowerCase(); });
    if (!match) return { error: 'Option not found: ' + want, available: opts.slice(0, 50).map(function(o){ return (o.textContent || '').trim() + ' (value=' + o.value + ')'; }) };
    var group = match.parentNode;
    if (match.disabled || match.hasAttribute('disabled') || (group && group.tagName === 'OPTGROUP' && group.hasAttribute('disabled'))) return { error: 'Option disabled: ' + want, option: { value: match.value, text: (match.textContent || '').trim() } };
    chosen.push(match);
  }
  var markTrusted = globalThis.__obscura_markTrusted || function(e){ return e; };
  var setField = globalThis.__obscura_setFieldValue || function(e, f, v){ e[f] = v; };
  if (multiple) { for (var i = 0; i < opts.length; i++) opts[i].selected = chosen.indexOf(opts[i]) >= 0; }
  // Obscura serializes a submitted <select> from its value; selectedIndex changes are not submitted
  else { setField(el, 'value', chosen[0].value); if (el.selectedIndex !== opts.indexOf(chosen[0])) el.selectedIndex = opts.indexOf(chosen[0]); }
  el.dispatchEvent(markTrusted(new Event('input', { bubbles: true })));
  el.dispatchEvent(markTrusted(new Event('change', { bubbles: true })));
  return { ok: true, selected: chosen.map(function(o){ return { value: o.value, text: (o.textContent || '').trim() }; }) };
}`;

export const SCROLL_PAGE = `function scrollPage(direction, amount) {
  var h = window.innerHeight || 720, w = window.innerWidth || 1280;
  var amt = typeof amount === 'number' && amount > 0 ? amount : (direction === 'left' || direction === 'right' ? w : h);
  var se = document.scrollingElement || document.documentElement || document.body;
  var maxY = Math.max(se ? se.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  var x0 = Math.round(window.scrollX), y0 = Math.round(window.scrollY);
  switch (direction) {
    case 'top': window.scrollTo(0, 0); break;
    case 'bottom': window.scrollTo(window.scrollX, maxY); break;
    case 'up': window.scrollBy(0, -amt); break;
    case 'left': window.scrollBy(-amt, 0); break;
    case 'right': window.scrollBy(amt, 0); break;
    default: window.scrollBy(0, amt);
  }
  // like a browser: scroll events only when the position changed, and trusted (Obscura does not fire them itself)
  var markTrusted = globalThis.__obscura_markTrusted || function(e){ return e; };
  if (Math.round(window.scrollX) !== x0 || Math.round(window.scrollY) !== y0) {
    try { document.dispatchEvent(markTrusted(new Event('scroll', { bubbles: true }))); } catch (_e) {}
    try { window.dispatchEvent(markTrusted(new Event('scroll'))); } catch (_e) {}
  }
  return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), maxY: Math.round(Math.max(0, maxY - h)), viewportHeight: h, pageHeight: maxY };
}`;

export const PAGE_INFO = `function pageInfo() {
  var se = document.scrollingElement || document.documentElement || document.body;
  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    scrollX: Math.round(window.scrollX || 0),
    scrollY: Math.round(window.scrollY || 0),
    innerWidth: window.innerWidth || 0,
    innerHeight: window.innerHeight || 0,
    pageHeight: Math.max(se ? se.scrollHeight : 0, document.body ? document.body.scrollHeight : 0),
    timeOrigin: (typeof performance !== 'undefined' && performance.timeOrigin) || 0,
  };
}`;

/**
 * Returns why a selector is unusable, or null. Standard engines throw on bad
 * selectors, and there a selector that did not throw is valid (their
 * CSS.supports rejects selector lists such as "h1, h2"). Obscura never throws,
 * so it is asked through CSS.supports instead.
 */
export const SELECTOR_PROBLEM = String.raw`function selectorProblem(selector) {
  try { document.querySelector(selector); } catch (e) { return String((e && e.message) || e); }
  try { document.querySelector('div['); return lenientCheck(); } catch (_strict) { return null; }
  function lenientCheck() {
    try {
      if (typeof CSS !== 'undefined' && CSS && typeof CSS.supports === 'function' && !CSS.supports('selector(' + selector + ')')) return 'the browser could not parse it';
    } catch (_e) {}
    return null;
  }
}`;

export const STORAGE_STATE = `function storageState() {
  var ls = [], ss = [];
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); ls.push({ name: k, value: localStorage.getItem(k) }); } } catch (_e) {}
  try { for (var j = 0; j < sessionStorage.length; j++) { var k2 = sessionStorage.key(j); ss.push({ name: k2, value: sessionStorage.getItem(k2) }); } } catch (_e) {}
  return { origin: location.origin || '', localStorage: ls, sessionStorage: ss };
}`;

export const APPLY_STORAGE = `function applyStorage(entries) {
  var applied = 0, errors = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    try { (e.session ? sessionStorage : localStorage).setItem(e.name, e.value); applied++; } catch (err) { errors.push(e.name + ': ' + (err && err.message || err)); }
  }
  return { applied: applied, errors: errors };
}`;

export const QUERY_COUNT = `function queryCount(selector) { return document.querySelectorAll(selector).length; }`;

export const QUERY_ONE = `function queryOne(selector) { return document.querySelector(selector); }`;

export const GET_ATTRIBUTE = `function getAttr(name) {
  var v = this.getAttribute(name);
  if (v === null && name === 'value' && 'value' in this) v = this.value;
  if (v === null && name === 'checked' && 'checked' in this) v = String(!!this.checked);
  return v;
}`;

/** Safely turn an arbitrary evaluation result into something JSON-serialisable. `this` = the value. */
export const SERIALIZE_VALUE = `function serializeValue(maxLen) {
  var seen = new WeakSet();
  // Rough JSON size budget: once used up, remaining items become truncation markers,
  // so large values stay valid JSON and the walk stops early.
  var left = maxLen;
  function cut(s) {
    if (s.length > left + 200) { var keep = Math.max(left, 200); s = s.slice(0, keep) + '…(truncated ' + (s.length - keep) + ' chars)'; }
    left -= s.length + 4;
    return s;
  }
  function ser(v, depth) {
    var r = ser0(v, depth);
    if (typeof r === 'string') return cut(r);
    if (r && typeof r.__type === 'string' && typeof r.value === 'string') r.value = cut(r.value);
    else left -= 6;
    return r;
  }
  function ser0(v, depth) {
    if (v === undefined) return { __type: 'undefined' };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? v : { __type: 'number', value: String(v) };
    if (typeof v === 'bigint') return { __type: 'bigint', value: String(v) };
    if (typeof v === 'symbol') return { __type: 'symbol', value: String(v) };
    if (typeof v === 'function') return { __type: 'function', value: 'function ' + (v.name || 'anonymous') };
    if (v && typeof v.nodeType === 'number') {
      if (v.nodeType === 1) return { __type: 'element', value: (v.outerHTML || '').slice(0, 500) };
      if (v.nodeType === 3) return { __type: 'text', value: v.data };
      if (v.nodeType === 9) return { __type: 'document', value: String(v.URL || location.href) };
      return { __type: 'node', value: v.nodeName };
    }
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return { __type: 'error', value: String(v.stack || v.message || v) };
    if (typeof v === 'object') {
      if (seen.has(v)) return { __type: 'circular' };
      if (depth > 6) return { __type: 'truncated' };
      seen.add(v);
      if (Array.isArray(v) || (typeof NodeList !== 'undefined' && v instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && v instanceof HTMLCollection)) {
        var arr = [];
        for (var i = 0; i < v.length && i < 500 && left > 0; i++) arr.push(ser(v[i], depth + 1));
        if (v.length > arr.length) arr.push({ __type: 'truncated', value: (v.length - arr.length) + ' more items' });
        return arr;
      }
      if (v instanceof Map) { var mo = {}; v.forEach(function(val, key){ if (left > 0) mo[String(key)] = ser(val, depth + 1); else mo['…'] = 'truncated'; }); return { __type: 'Map', value: mo }; }
      if (v instanceof Set) { var so = [], skipped = 0; v.forEach(function(val){ if (left > 0) so.push(ser(val, depth + 1)); else skipped++; }); if (skipped) so.push({ __type: 'truncated', value: skipped + ' more items' }); return { __type: 'Set', value: so }; }
      var out = {}, n = 0;
      for (var k in v) { if (n++ > 200 || left <= 0) { out['…'] = 'truncated'; break; } left -= k.length + 4; try { out[k] = ser(v[k], depth + 1); } catch (e) { out[k] = { __type: 'error', value: String(e) }; } }
      return out;
    }
    return String(v);
  }
  var json = JSON.stringify(ser(this, 0));
  if (json === undefined) json = 'null';
  // last resort only: the budget above counts raw string lengths, and JSON escaping can roughly double them
  var hardMax = maxLen * 3;
  return json.length > hardMax ? json.slice(0, hardMax) + '…(truncated ' + (json.length - hardMax) + ' chars)' : json;
}`;
