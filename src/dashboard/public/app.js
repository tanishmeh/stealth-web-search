// Stealth Web Search live dashboard.
// Vanilla ES2022 module, no dependencies. Every string that comes from the
// server, the agent or a web page is inserted with textContent (never innerHTML).

import { appendNewTimed, updateClockSkew } from './lib.js';

const CAP ={ activity: 300, console: 500, network: 500, logBuffer: 2000, logRows: 500 };
const LEVEL_VALUE = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LOG_DETAIL_SKIP = new Set(['time', 'level', 'levelName', 'msg', 'component', 'pid', 'hostname', 'name']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const FOLLOW_SLACK_PX = 28;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ utilities

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`sbm.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sbm.${key}`, JSON.stringify(value));
    } catch {
      // storage may be unavailable (private mode); preferences are optional
    }
  },
};

/** Create an element. `text` is always assigned via textContent. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'title') el.title = String(value);
      else if (key === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setIcon(svg, name) {
  const use = svg?.querySelector('use');
  if (use && use.getAttribute('href') !== `#i-${name}`) use.setAttribute('href', `#i-${name}`);
}

function setText(el, text) {
  const value = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== value) el.textContent = value;
}

function setAttr(el, name, value) {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== String(value)) {
    el.setAttribute(name, String(value));
  }
}

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function truncate(s, max) {
  s = str(s);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function parseTime(iso) {
  const t = Date.parse(str(iso));
  return Number.isFinite(t) ? t : null;
}

function fmtClock(iso, withMs = false) {
  const t = parseTime(iso);
  if (t === null) return '--:--:--';
  const d = new Date(t);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

function fmtDuration(ms) {
  if (num(ms) === null || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${pad(Math.floor((ms % 60_000) / 1000))}s`;
}

function fmtUptime(sec) {
  if (num(sec) === null) return '–';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function fmtAgo(ms) {
  if (num(ms) === null) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 48) return `${hr}h ${pad(m % 60)}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtBytes(n) {
  if (num(n) === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function hashHue(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function splitUrl(url) {
  const raw = str(url);
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { scheme: u.protocol, host: u.host, rest: `${u.pathname}${u.search}${u.hash}` };
    }
    return { scheme: u.protocol, host: '', rest: raw };
  } catch {
    return { scheme: '', host: '', rest: raw };
  }
}

/** Pretty-print JSON into a <pre> with token colouring, built from text nodes only. */
function jsonBlock(value, cls = '') {
  const pre = h('pre', { class: `code ${cls}`.trim() });
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';
  if (typeof value === 'string' || text.length > 60_000) {
    pre.textContent = text;
    return pre;
  }
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  const frag = document.createDocumentFragment();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) {
      frag.append(h('span', { class: m[2] ? 'j-key' : 'j-str', text: m[1] }));
      if (m[2]) frag.append(m[2]);
    } else if (m[3]) {
      frag.append(h('span', { class: 'j-lit', text: m[3] }));
    } else {
      frag.append(h('span', { class: 'j-num', text: m[4] }));
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  pre.append(frag);
  return pre;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ model

const model = {
  hydrated: false,
  server: null,
  obscura: null,
  browser: null,
  liveView: null,
  uptime: { sec: null, at: 0 },
  sessions: [],
  tabs: [],
  activeTabId: null,
  tabsSignature: '',
  lastBrowserEvent: null,
  clockSkew: null, // ms the browser clock is ahead of the server clock
  browsers: [], // main + sub-agent/script browsers the server runs
  agents: new Map(), // run id -> summary
  agentsInfo: null,
  scripts: [],
  scriptsLoadedAt: 0,
};

/** The server's current time on the browser clock, for ages of server timestamps. */
const serverNow = () => Date.now() - (model.clockSkew ?? 0);

const tabExists = (tabId) => model.tabs.some((t) => t.id === tabId);

const ui = {
  /** Browser whose live view, tabs, console and network are shown ("main" or a sub-agent/script browser id). */
  watch: store.get('watch', 'main'),
  paused: false,
  suspended: false,
  hiddenTimer: null,
  view: store.get('view', 'console'),
  theme: store.get('theme', 'system'),
  split: store.get('split', 60),
};

// ------------------------------------------------------------------ render scheduling

const dirty = new Set();
let flushQueued = false;

// requestAnimationFrame batches DOM work with painting; the timeout guarantees
// progress where rAF is throttled (background or occluded windows, embedded panes).
function mark(...parts) {
  for (const part of parts) dirty.add(part);
  if (flushQueued) return;
  flushQueued = true;
  if (!document.hidden) requestAnimationFrame(flush);
  setTimeout(flush, document.hidden ? 250 : 120);
}

function flush() {
  if (!flushQueued) return;
  flushQueued = false;
  const parts = [...dirty];
  dirty.clear();
  for (const part of parts) {
    try {
      renderers[part]?.();
    } catch (err) {
      console.error(`[dashboard] render "${part}" failed`, err);
    }
  }
}

// ------------------------------------------------------------------ event stream

const conn = {
  es: null,
  state: 'connecting', // connecting | open | reconnecting
  everOpened: false,
  attempts: 0,
  retryAt: 0,
  retryTimer: null,
  lastMessageAt: 0,
  unauthorized: false, // the server answers 401 (AUTH_TOKEN changed or the token cookie is gone)
};

const wantLive = () => !ui.paused && !ui.suspended;

function connect() {
  clearTimeout(conn.retryTimer);
  conn.retryTimer = null;
  if (conn.es) conn.es.close();
  const params = new URLSearchParams();
  if (wantLive()) params.set('live', '1');
  if (ui.watch && ui.watch !== 'main') params.set('browser', ui.watch);
  const query = params.toString();
  const es = new EventSource(query ? `/api/events?${query}` : '/api/events');
  conn.es = es;
  conn.lastMessageAt = Date.now();
  es.addEventListener('error', () => {
    if (conn.es !== es) return;
    es.close();
    conn.es = null;
    scheduleReconnect();
  });
  for (const [type, handler] of Object.entries(handlers)) {
    es.addEventListener(type, (ev) => {
      if (conn.es !== es) return;
      conn.lastMessageAt = Date.now();
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
        handler(data);
      } catch (err) {
        console.error(`[dashboard] failed to handle "${type}" event`, err);
      }
    });
  }
}

function scheduleReconnect() {
  clearTimeout(conn.retryTimer);
  const base = Math.min(15_000, 1000 * 2 ** conn.attempts);
  const delay = Math.round(base * (0.85 + Math.random() * 0.3));
  conn.attempts++;
  conn.retryAt = Date.now() + delay;
  setConnState(conn.everOpened ? 'reconnecting' : 'connecting');
  conn.retryTimer = setTimeout(connect, delay);
  void probeAuth();
}

// EventSource hides the HTTP status of a failed connection; ask the server directly so a
// rejected token is reported as such instead of as an endless "reconnecting".
async function probeAuth() {
  let unauthorized = false;
  try {
    const res = await fetch('/', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
    unauthorized = res.status === 401;
  } catch {
    // server unreachable: an ordinary reconnect
  }
  if (conn.es === null && unauthorized !== conn.unauthorized) {
    conn.unauthorized = unauthorized;
    mark('header', 'stage');
  }
}

function setConnState(next) {
  if (conn.state === next) return;
  conn.state = next;
  $('app').dataset.conn = next;
  mark('header', 'stage', 'framemeta');
}

// stalled stream watchdog: the server sends a status event every 5 s
setInterval(() => {
  if (conn.state === 'open' && conn.es && Date.now() - conn.lastMessageAt > 25_000) {
    console.warn('[dashboard] event stream stalled; reconnecting');
    conn.es.close();
    conn.es = null;
    scheduleReconnect();
  }
}, 5000);

window.addEventListener('online', () => {
  if (!conn.es) {
    conn.attempts = 0;
    connect();
  }
});

// Stop the screencast while the dashboard sits in a background tab for a while.
document.addEventListener('visibilitychange', () => {
  clearTimeout(ui.hiddenTimer);
  if (document.hidden) {
    ui.hiddenTimer = setTimeout(() => {
      if (!document.hidden || ui.paused || ui.suspended) return;
      ui.suspended = true;
      if (conn.es) connect();
    }, 30_000);
  } else {
    if (ui.suspended) {
      ui.suspended = false;
      if (conn.es) connect();
    }
    mark('stage', 'framemeta', 'activity', 'console', 'network', 'logs');
    resizeScreen();
  }
});

// ------------------------------------------------------------------ event handlers

const handlers = {
  hello(state) {
    if (!conn.everOpened) performance.mark?.('sbm:first-hello');
    hydrate(state);
    conn.attempts = 0;
    conn.everOpened = true;
    conn.unauthorized = false;
    setConnState('open');
  },
  status(state) {
    applyStatus(state);
  },
  activity(entry) {
    upsertActivity(entry, true);
  },
  console(entry) {
    addConsole([entry], false);
  },
  network(entry) {
    upsertNetwork(entry);
  },
  log(record) {
    addLogs([record], false);
  },
  frame(frame) {
    onFrame(frame);
  },
  pointer(pointer) {
    onPointer(pointer);
  },
  tabs(data) {
    applyTabs(data);
  },
  sessions(list) {
    model.sessions = Array.isArray(list) ? list : [];
    mark('header', 'sessions');
  },
  agent(summary) {
    upsertAgent(summary);
  },
  browsers(list) {
    if (!Array.isArray(list)) return;
    model.browsers = list;
    mark('browsers', 'agents', 'stage');
  },
  browser(ev) {
    if (!ev || typeof ev !== 'object') return;
    model.lastBrowserEvent = ev;
    if (ev.event === 'closed') {
      // the watched sub-agent/script browser was discarded: keep its last frame on screen
      const info = model.browsers.find((b) => b.id === (ev.browserId ?? 'main'));
      if (info) info.status = 'closed';
      if (model.browser) model.browser = { ...model.browser, connected: false, closed: true };
      mark('browsers', 'stage', 'header');
      return;
    }
    if (model.browser && (ev.event === 'connected' || ev.event === 'disconnected')) {
      model.browser = { ...model.browser, connected: ev.event === 'connected' };
    }
    // the last frame stays (dimmed) while disconnected; once reconnected, a frame of a lost tab is stale
    if (ev.event === 'connected' && live.frame && !tabExists(live.frame.tabId)) clearFrame();
    mark('header', 'stage');
  },
};

function hydrate(state) {
  if (!state || typeof state !== 'object') return;
  const restarted = model.server && state.server && model.server.startedAt !== state.server.startedAt;
  // the server shows another browser than the one we asked for (it is gone): start from a clean slate
  const fellBack = typeof state.watching === 'string' && state.watching !== ui.watch;
  if (!model.hydrated || restarted || fellBack) resetData();
  if (fellBack) {
    model.tabs = [];
    model.activeTabId = null;
    model.tabsSignature = '';
  }
  model.hydrated = true;
  applyStatus(state);
  model.sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const history = state.history ?? {};
  // the server's list is authoritative: runs of a restarted server are gone
  model.agents = new Map();
  for (const a of Array.isArray(history.agents) ? history.agents : []) upsertAgent(a);
  for (const id of [...agentsUi.open]) if (!model.agents.has(id)) agentsUi.open.delete(id);
  for (const id of [...agentsUi.details.keys()]) if (!model.agents.has(id)) agentsUi.details.delete(id);
  const browserEvents = Array.isArray(history.browserEvents) ? history.browserEvents : [];
  if (browserEvents.length) model.lastBrowserEvent = browserEvents[browserEvents.length - 1];
  for (const entry of Array.isArray(history.activity) ? history.activity : []) upsertActivity(entry, false);
  addConsole(Array.isArray(history.console) ? history.console : [], true);
  for (const entry of Array.isArray(history.network) ? history.network : []) upsertNetwork(entry);
  addLogs(Array.isArray(history.logs) ? history.logs : [], true);
  mark('header', 'stage', 'sessions', 'framemeta', 'agents', 'browsers');
}

function resetData() {
  act.filterTool = '';
  logs.component = '';
  if ($('activity-tool')) $('activity-tool').value = '';
  if ($('logs-component')) $('logs-component').value = '';
  for (const rec of act.map.values()) rec.el?.remove();
  act.map.clear();
  act.dirty.clear();
  act.running.clear();
  act.tools.clear();
  cons.buf.length = 0;
  cons.rebuild = true;
  net.map.clear();
  net.dirty.clear();
  net.rebuild = true;
  logs.buf.length = 0;
  logs.warns = 0;
  logs.errors = 0;
  logs.open.clear();
  logs.components.clear();
  logs.rebuild = true;
  act.open.clear();
  // "Clear" marks are timestamps of the previous server; a restarted one may have a different clock
  cons.clearedAt = '';
  net.clearedAt = '';
  model.tabsSignature = '';
  model.lastBrowserEvent = null;
  model.clockSkew = null;
  clearFrame();
  mark('activity', 'console', 'network', 'logs');
}

function applyStatus(state) {
  if (!state || typeof state !== 'object') return;
  if (state.server) {
    model.server = state.server;
    model.uptime = { sec: num(state.server.uptimeSec), at: Date.now() };
    model.clockSkew = updateClockSkew(model.clockSkew, state.server.now, Date.now());
  }
  if (state.obscura) model.obscura = state.obscura;
  if ('obscuraIsolated' in state) model.obscuraIsolated = state.obscuraIsolated ?? null;
  if (state.browser) {
    model.browser = state.browser;
    if (Array.isArray(state.browser.tabs)) applyTabs({ tabs: state.browser.tabs, activeTabId: state.browser.activeTabId });
  }
  if (state.liveView) model.liveView = state.liveView;
  if (Array.isArray(state.browsers)) model.browsers = state.browsers;
  if (state.agents) model.agentsInfo = state.agents;
  mark('agents');
  if (typeof state.watching === 'string' && state.watching !== ui.watch) {
    // the browser we asked for is gone (e.g. after a server restart): the server shows the main one
    ui.watch = state.watching;
    store.set('watch', ui.watch);
  }
  mark('browsers');
  if (Array.isArray(state.sessions)) {
    model.sessions = state.sessions;
    mark('sessions');
  }
  mark('header', 'stage');
}

function applyTabs(data) {
  if (!data || typeof data !== 'object') return;
  const tabs = Array.isArray(data.tabs) ? data.tabs.filter((t) => t && typeof t.id === 'string') : [];
  const activeTabId = typeof data.activeTabId === 'string' ? data.activeTabId : null;
  const signature = JSON.stringify([activeTabId, tabs.map((t) => [t.id, t.url, t.title])]);
  if (signature === model.tabsSignature) return;
  model.tabsSignature = signature;
  model.tabs = tabs;
  model.activeTabId = activeTabId;
  // a closed tab's frame must not keep showing its page (while disconnected it stays, dimmed, for context;
  // a finished sub-agent's browser keeps its last frame)
  if (live.frame && !tabExists(live.frame.tabId) && model.browser?.connected !== false && !watchingClosed()) clearFrame();
  mark('tabs', 'stage');
}

// ------------------------------------------------------------------ header

const THEMES = ['system', 'dark', 'light'];

function applyTheme(theme) {
  ui.theme = THEMES.includes(theme) ? theme : 'system';
  if (ui.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ui.theme);
  const btn = $('theme-toggle');
  setIcon(btn.querySelector('svg'), ui.theme === 'system' ? 'monitor' : ui.theme === 'dark' ? 'moon' : 'sun');
  const label = `Theme: ${ui.theme} (click to change)`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  const dark = ui.theme === 'dark' || (ui.theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0d13' : '#ffffff');
}

function pill(id, text, tone, title) {
  const el = $(id);
  setText(el.querySelector('.pill-text'), text);
  setAttr(el, 'data-tone', tone || null);
  if (title !== undefined) setAttr(el, 'title', title);
}

function renderHeader() {
  const { server, obscura, browser, liveView } = model;
  if (server) {
    setText($('version'), server.version ? `v${server.version}` : '');
    setText($('mcp-url'), server.mcpUrl ?? '');
    $('mcp-url').title = server.mcpUrl ?? '';
    const title = `Stealth Web Search${server.version ? ` ${server.version}` : ''}`;
    if (document.title !== title) document.title = title;
  }

  if (conn.state !== 'open' && conn.unauthorized) {
    pill('pill-conn', 'Unauthorized', 'err', 'The server rejected the dashboard token');
  } else if (conn.state === 'open') {
    if (ui.paused) pill('pill-conn', 'Paused', 'warn', 'Live view paused; events keep streaming');
    else pill('pill-conn', 'Live', 'live', 'Connected to the server event stream');
  } else if (conn.state === 'reconnecting') {
    const secs = Math.max(0, Math.ceil((conn.retryAt - Date.now()) / 1000));
    pill('pill-conn', conn.es ? 'Reconnecting…' : `Reconnecting in ${secs}s`, 'warn', 'Lost connection to the server');
  } else {
    pill('pill-conn', 'Connecting…', 'warn', 'Connecting to the server');
  }

  if (obscura) {
    const restarts = num(obscura.restarts) ?? 0;
    const suffix = restarts ? ` · ${restarts} restart${restarts === 1 ? '' : 's'}` : '';
    let details = [
      `Obscura ${obscura.version ?? ''}`.trim(),
      `mode: ${obscura.mode ?? '?'}`,
      obscura.pid ? `pid ${obscura.pid}` : null,
      obscura.lastExit ? `last exit: code ${obscura.lastExit.code ?? '–'} ${obscura.lastExit.signal ?? ''} at ${fmtClock(obscura.lastExit.at)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const iso = model.obscuraIsolated;
    if (iso) details += `\nSub-agent engine: ${iso.ready ? 'ready' : iso.running ? 'starting' : 'down'}${iso.restarts ? ` (${iso.restarts} restart${iso.restarts === 1 ? '' : 's'})` : ''}${iso.pid ? `, pid ${iso.pid}` : ''}`;
    if (obscura.ready && iso && !iso.ready) pill('pill-obscura', 'Obscura ready · sub-agent engine down', 'warn', details);
    else if (obscura.ready) pill('pill-obscura', `Obscura ready${suffix}`, restarts ? 'warn' : 'ok', details);
    else if (obscura.running) pill('pill-obscura', `Obscura starting${suffix}`, 'warn', details);
    else pill('pill-obscura', `Obscura down${suffix}`, 'err', details);
  }

  // between switching browsers and the new stream's first message
  if (!browser) pill('pill-cdp', 'CDP …', 'muted', 'Waiting for the server');
  if (browser) {
    const connected = browser.connected !== false;
    const watchedOther = ui.watch !== 'main';
    const cdpTitle = model.lastBrowserEvent?.reason ? `Last event: ${model.lastBrowserEvent.event} (${model.lastBrowserEvent.reason})` : 'Chrome DevTools Protocol connection to Obscura';
    if (connected) pill('pill-cdp', 'CDP connected', 'ok', cdpTitle);
    // a sub-agent's browser is closed when its run ends, or not connected until its first page: not an error
    else if (watchedOther && (browser.closed || watchingClosed())) pill('pill-cdp', 'Browser closed', 'muted', cdpTitle);
    else if (watchedOther && !model.tabs.length && model.lastBrowserEvent?.event !== 'disconnected') pill('pill-cdp', 'CDP idle', 'muted', cdpTitle);
    else pill('pill-cdp', 'CDP disconnected', 'err', cdpTitle);
    const stealthTitle = [
      browser.stealth ? 'Obscura runs with --stealth' : 'Stealth mode is off (OBSCURA_STEALTH=false)',
      browser.proxy ? 'Proxy: configured' : 'Proxy: none',
      browser.viewport ? `Viewport: ${browser.viewport.width}×${browser.viewport.height}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    pill('pill-stealth', browser.stealth ? 'Stealth on' : 'Stealth off', browser.stealth ? 'accent' : 'muted', stealthTitle);
  }

  if (liveView) {
    const viewers = num(liveView.viewers) ?? 0;
    const text = liveView.enabled === false ? 'Live view off' : `${viewers} viewer${viewers === 1 ? '' : 's'}`;
    pill('pill-viewers', text, liveView.enabled === false ? 'muted' : null, `Dashboards watching the live view\n${num(liveView.frames) ?? 0} frames streamed`);
  }

  const clients = model.sessions.length;
  pill('pill-clients', `${clients} MCP client${clients === 1 ? '' : 's'}`, clients ? 'ok' : null, clients ? model.sessions.map((s) => s.client ?? 'unknown client').join('\n') : 'No sessionful MCP clients connected');

  if (model.uptime.sec !== null) {
    const sec = model.uptime.sec + (Date.now() - model.uptime.at) / 1000;
    pill('pill-uptime', `Up ${fmtUptime(sec)}`, null, server?.startedAt ? `Started ${new Date(server.startedAt).toLocaleString()}` : undefined);
  }
}

// ------------------------------------------------------------------ live view

const live = {
  canvas: $('frame'),
  ctx: null,
  pending: null,
  busy: false,
  hasFrame: false,
  frame: null,
  drawnAt: 0,
  capturedAt: 0,
  arrivals: [],
  ar: '',
};
live.ctx = live.canvas.getContext('2d', { alpha: false });

function onFrame(frame) {
  if (!frame || typeof frame.data !== 'string' || !frame.data || !wantLive()) return;
  if ((frame.browserId ?? 'main') !== ui.watch) return; // a frame of the browser we watched before switching
  if (frame.tabId && !tabExists(frame.tabId) && !watchingClosed()) return; // tabs are always announced before their frames
  const now = performance.now();
  live.arrivals.push(now);
  while (live.arrivals.length && now - live.arrivals[0] > 3000) live.arrivals.shift();
  live.pending = frame;
  if (!live.busy) void pumpFrames();
}

const nextPaint = () =>
  new Promise((resolve) => {
    if (!document.hidden) requestAnimationFrame(() => resolve());
    setTimeout(resolve, document.hidden ? 0 : 100);
  });

async function pumpFrames() {
  live.busy = true;
  try {
    while (live.pending) {
      const frame = live.pending;
      live.pending = null;
      let image;
      try {
        image = await decodeFrame(frame);
      } catch (err) {
        console.warn('[dashboard] could not decode a live frame', err);
        continue;
      }
      if (live.pending) {
        // a newer frame arrived while decoding: skip this one
        image.close?.();
        continue;
      }
      await nextPaint();
      if (!wantLive()) {
        image.close?.();
        break;
      }
      if ((frame.browserId ?? 'main') !== ui.watch || (frame.tabId && !tabExists(frame.tabId) && !watchingClosed())) {
        // the tab closed, the data was reset or another browser was selected while this frame was decoding
        image.close?.();
        continue;
      }
      drawFrame(image, frame);
    }
  } finally {
    live.busy = false;
  }
}

async function decodeFrame(frame) {
  const type = frame.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = new Blob([base64ToBytes(frame.data)], { type });
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawFrame(image, frame) {
  const w = image.width || image.naturalWidth;
  const hgt = image.height || image.naturalHeight;
  if (!w || !hgt) return;
  if (live.canvas.width !== w || live.canvas.height !== hgt) {
    live.canvas.width = w;
    live.canvas.height = hgt;
  }
  live.ctx.drawImage(image, 0, 0);
  image.close?.();
  const first = !live.hasFrame;
  live.hasFrame = true;
  live.drawnAt = Date.now();
  // age of what is on screen: the server capture time moved onto the browser clock, never in the future
  const capturedAt = parseTime(frame.at);
  live.capturedAt = capturedAt === null ? live.drawnAt : Math.min(live.drawnAt, capturedAt + (model.clockSkew ?? 0));
  live.frame = {
    tabId: str(frame.tabId),
    url: str(frame.url),
    title: str(frame.title),
    at: frame.at,
    width: num(frame.width) || w,
    height: num(frame.height) || hgt,
    imageWidth: w,
    imageHeight: hgt,
  };
  const ar = `${w} / ${hgt}`;
  if (ar !== live.ar || first) {
    live.ar = ar;
    $('stage').style.setProperty('--frame-ar', ar);
    resizeScreen();
  }
  if (first) {
    performance.mark?.('sbm:first-frame');
    mark('stage');
  }
  mark('framemeta');
}

function clearFrame() {
  if (!live.hasFrame) return;
  live.hasFrame = false;
  live.frame = null;
  live.pending = null;
  live.arrivals.length = 0;
  $('markers').replaceChildren();
  mark('stage', 'framemeta');
}

function frameAspect() {
  if (live.frame) return live.frame.imageWidth / live.frame.imageHeight;
  const vp = model.browser?.viewport;
  return vp?.width && vp?.height ? vp.width / vp.height : 16 / 9;
}

let stagePadding = null;
function resizeScreen() {
  const stage = $('stage');
  const screen = $('screen');
  if (stagePadding === null) {
    const cs = getComputedStyle(stage);
    stagePadding = { x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) };
  }
  const availW = Math.max(0, stage.clientWidth - stagePadding.x);
  const availH = Math.max(0, stage.clientHeight - stagePadding.y);
  if (!availW || !availH) return;
  const ar = frameAspect();
  let width = availW;
  let height = width / ar;
  if (height > availH) {
    height = availH;
    width = height * ar;
  }
  screen.style.width = `${Math.floor(width)}px`;
  screen.style.height = `${Math.floor(height)}px`;
}

new ResizeObserver(() => {
  stagePadding = null;
  resizeScreen();
}).observe($('stage'));

const POINTER_VERB = { click: 'Click', type: 'Type', key: 'Key', scroll: 'Scroll' };

function onPointer(p) {
  if (!p || typeof p !== 'object' || !wantLive() || !live.hasFrame || document.hidden) return;
  if (p.tabId && model.activeTabId && p.tabId !== model.activeTabId) return;
  const x = num(p.x);
  const y = num(p.y);
  if (x === null || y === null) return;
  const vw = live.frame?.width || model.browser?.viewport?.width;
  const vh = live.frame?.height || model.browser?.viewport?.height;
  if (!vw || !vh || x < 0 || y < 0 || x > vw || y > vh) return;
  const kind = POINTER_VERB[p.kind] ? p.kind : 'click';
  const rx = x / vw;
  const ry = y / vh;
  const label = str(p.label).replace(/\s+/g, ' ').trim();
  const marker = h(
    'div',
    { class: `marker marker-${kind}${rx > 0.66 ? ' flip-x' : ''}${ry > 0.82 ? ' flip-y' : ''}`, style: { left: `${rx * 100}%`, top: `${ry * 100}%` } },
    h('span', { class: 'ring' }),
    h('span', { class: 'ring' }),
    h('span', { class: 'dot' }),
    h('span', { class: 'tag', text: label ? `${POINTER_VERB[kind]} “${truncate(label, 48)}”` : POINTER_VERB[kind] }),
  );
  const layer = $('markers');
  layer.append(marker);
  while (layer.childElementCount > 10) layer.firstElementChild.remove();
  setTimeout(() => marker.remove(), 2400);
}

function stageState() {
  if (conn.state !== 'open' && conn.unauthorized) {
    return {
      icon: 'lock',
      tone: 'err',
      title: 'Not authorized',
      sub: 'The server requires an access token (AUTH_TOKEN) and did not accept this browser’s. Reopen the dashboard as /?token=<AUTH_TOKEN>.',
      action: conn.es ? null : { label: 'Retry now', run: () => { conn.attempts = 0; connect(); mark('stage', 'header'); } },
    };
  }
  if (!conn.everOpened) {
    return { icon: 'refresh', spin: true, title: 'Connecting to the server…', sub: '' };
  }
  if (conn.state === 'reconnecting') {
    const secs = Math.max(0, Math.ceil((conn.retryAt - Date.now()) / 1000));
    return {
      icon: 'unplug',
      tone: 'warn',
      title: 'Lost connection to the server',
      sub: conn.es ? 'Reconnecting…' : `Reconnecting in ${secs}s. The dashboard catches up automatically.`,
      action: conn.es ? null : { label: 'Retry now', run: () => { conn.attempts = 0; connect(); mark('stage', 'header'); } },
    };
  }
  if (ui.paused) {
    return {
      icon: 'pause',
      tone: 'warn',
      title: 'Live view paused',
      sub: 'The server stops streaming frames while paused. Activity, console, network and logs keep updating.',
      action: { label: 'Resume live view', icon: 'play', run: togglePause },
    };
  }
  if (model.liveView && model.liveView.enabled === false) {
    return { icon: 'eye-off', title: 'Live view is disabled', sub: 'Set LIVE_VIEW_ENABLED=true (and DASHBOARD_ENABLED=true) on the server to watch the browser here.' };
  }
  const watched = watchInfo();
  // a finished run's browser: listed as closed, or already dropped from the list
  if ((watched && watched.kind !== 'main' && watched.status === 'closed') || (!watched && ui.watch !== 'main' && model.browser?.closed)) {
    if (live.hasFrame) return null; // the last frame shows where the run ended
    return {
      icon: 'browser',
      title: `${watched?.label ?? ui.watch} is closed`,
      sub: 'The run finished and its private browser was discarded. Watch the main browser or a running agent.',
      action: { label: 'Watch the main browser', run: () => switchBrowser('main') },
    };
  }
  // sub-agent and script browsers run on the second engine when there is one
  const ob = ui.watch !== 'main' && model.obscuraIsolated ? model.obscuraIsolated : model.obscura;
  if (ob && ob.mode === 'managed' && !ob.ready) {
    return ob.running
      ? { icon: 'cpu', spin: false, tone: 'warn', title: 'Browser engine is starting…', sub: ob.restarts ? `Obscura has restarted ${ob.restarts} time${ob.restarts === 1 ? '' : 's'}.` : '' }
      : { icon: 'alert', tone: 'err', title: 'Browser engine is down', sub: 'Obscura exited. The server restarts it automatically; check the Logs tab for details.' };
  }
  if (watched && watched.kind !== 'main' && !model.tabs.length && model.lastBrowserEvent?.event !== 'disconnected') {
    // a sub-agent's or script's browser that has not opened a page yet (it connects on first use)
    return { icon: 'bot', breathe: true, tone: 'accent', title: `${watched.label}: waiting for its first page`, sub: 'This is the private browser of a sub-agent or script run. Its live view appears as soon as it opens a page.' };
  }
  if (model.browser && model.browser.connected === false) {
    const reason = model.lastBrowserEvent?.event === 'disconnected' ? str(model.lastBrowserEvent.reason) : '';
    return { icon: 'unplug', tone: 'err', title: 'Browser disconnected', sub: `${reason ? `${reason}. ` : ''}The next tool call reconnects automatically.` };
  }
  if (!model.tabs.length) {
    return watched && watched.kind !== 'main'
      ? { icon: 'bot', breathe: true, tone: 'accent', title: `${watched.label}: waiting for its first page`, sub: 'This is the private browser of a sub-agent or script run. Its live view appears as soon as it opens a page.' }
      : { icon: 'browser', breathe: true, tone: 'accent', title: 'Waiting for the agent to open a page', sub: 'The live view appears here as soon as a tool call opens a tab.' };
  }
  if (!live.hasFrame) {
    return { icon: 'browser', breathe: true, title: 'Waiting for the first frame…', sub: '' };
  }
  return null;
}

function renderStage() {
  const state = stageState();
  const stage = $('stage');
  const overlay = $('stage-overlay');
  const screen = $('screen');
  screen.hidden = !live.hasFrame;
  stage.classList.toggle('dim', Boolean(state) && live.hasFrame);
  stage.dataset.state = state ? 'overlay' : 'live';
  if (live.hasFrame && screen.style.width === '') resizeScreen();
  overlay.hidden = !state;
  if (state) {
    const iconBox = $('overlay-icon');
    setIcon(iconBox.querySelector('svg'), state.icon);
    setAttr(iconBox, 'data-tone', state.tone ?? null);
    iconBox.classList.toggle('spin', Boolean(state.spin));
    iconBox.classList.toggle('breathe', Boolean(state.breathe));
    setText($('overlay-title'), state.title);
    setText($('overlay-sub'), state.sub);
    const btn = $('overlay-action');
    if (state.action) {
      btn.hidden = false;
      btn.replaceChildren(...(state.action.icon ? [icon(state.action.icon)] : []), h('span', { text: state.action.label }));
      btn.onclick = state.action.run;
    } else {
      btn.hidden = true;
      btn.onclick = null;
    }
  }
  const noTab = !model.tabs.length || conn.state !== 'open';
  setAttr($('btn-shot'), 'href', `/api/screenshot?browser=${encodeURIComponent(ui.watch)}`);
  setAttr($('btn-shot'), 'aria-disabled', noTab ? 'true' : null);
  setAttr($('btn-shot'), 'tabindex', noTab ? '-1' : null);
  renderOmnibox();
}

function renderTabs() {
  const strip = $('tabstrip');
  if (!model.tabs.length) {
    strip.replaceChildren(h('div', { class: 'btab placeholder', text: 'No open tabs' }));
  } else {
    strip.replaceChildren(
      ...model.tabs.map((tab) => {
        const { host } = splitUrl(tab.url);
        const name = str(tab.title).trim() || host || (tab.url === 'about:blank' ? 'New tab' : str(tab.url)) || 'New tab';
        const letter = (host.replace(/^www\./, '')[0] || name[0] || '•').toUpperCase();
        const active = tab.id === model.activeTabId;
        return h(
          'div',
          { class: 'btab', role: 'tab', 'aria-selected': String(active), title: `${name}\n${str(tab.url)}\n${tab.id}${active ? ' (active)' : ''}` },
          h('span', { class: 'btab-favicon', style: { '--hue': String(hashHue(host || name)) }, text: letter }),
          h('span', { class: 'btab-title', text: name }),
          h('span', { class: 'btab-id', text: tab.id }),
        );
      }),
    );
    // keep the active tab visible without scrolling the page itself
    const active = strip.querySelector('[aria-selected="true"]');
    if (active) {
      const left = active.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
      else if (left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + active.offsetWidth - strip.clientWidth + 8;
    }
  }
  renderOmnibox();
}

function renderOmnibox() {
  const tab = model.tabs.find((t) => t.id === model.activeTabId) ?? null;
  const url = tab ? str(tab.url) : live.hasFrame ? live.frame.url : '';
  const title = tab ? str(tab.title) : live.hasFrame ? live.frame.title : '';
  const urlEl = $('omnibox-url');
  const signature = `${url}\u0000${title}`;
  if (urlEl.dataset.sig === signature) return;
  urlEl.dataset.sig = signature;
  const parts = splitUrl(url);
  const iconEl = $('omnibox-icon');
  setIcon(iconEl, parts.scheme === 'https:' ? 'lock' : parts.scheme === 'http:' ? 'info' : 'globe');
  iconEl.classList.toggle('secure', parts.scheme === 'https:');
  if (!url) {
    urlEl.replaceChildren(h('span', { class: 'u-muted', text: 'No page open' }));
  } else if (parts.host) {
    urlEl.replaceChildren(
      h('span', { class: 'u-muted', text: `${parts.scheme}//` }),
      h('span', { class: 'u-host', text: parts.host }),
      h('span', { text: parts.rest === '/' ? '' : parts.rest }),
    );
  } else {
    urlEl.replaceChildren(h('span', { class: 'u-host', text: url }));
  }
  urlEl.title = url;
  setText($('omnibox-title'), title);
  $('omnibox-title').title = title;
}

function renderFrameMeta() {
  const el = $('framemeta');
  const textEl = $('framemeta-text');
  let tone = 'idle';
  let text = 'No frames';
  if (ui.paused) {
    tone = 'paused';
    text = 'Paused';
  } else if (conn.state !== 'open') {
    text = 'Offline';
  } else if (live.hasFrame) {
    const now = performance.now();
    while (live.arrivals.length && now - live.arrivals[0] > 3000) live.arrivals.shift();
    const lastArrival = live.arrivals[live.arrivals.length - 1];
    if (lastArrival !== undefined && now - lastArrival < 2500 && Date.now() - live.capturedAt < 10_000) {
      const recent = live.arrivals.filter((t) => now - t <= 2000).length;
      tone = 'live';
      text = `Live · ${recent >= 2 ? `${(recent / 2).toFixed(recent < 20 ? 1 : 0)} fps` : 'updating'}`;
    } else {
      text = `Idle · ${fmtAgo(Date.now() - live.capturedAt)}`;
    }
  }
  setAttr(el, 'data-tone', tone);
  setText(textEl, text);
  if (live.frame) {
    el.title = `Frame ${live.frame.imageWidth}×${live.frame.imageHeight} (viewport ${live.frame.width}×${live.frame.height}) of ${live.frame.tabId}\nCaptured ${fmtClock(new Date(live.capturedAt).toISOString())}${model.liveView ? `\n${model.liveView.frames ?? 0} frames streamed by the server` : ''}`;
  } else {
    el.title = 'Live view status';
  }
}

function renderWorking() {
  // only calls acting on the watched browser; agent/script tools (which wait on other browsers) are left out
  const running = [...act.running]
    .map((id) => act.map.get(id))
    .filter((r) => r && (r.entry.browserId ?? 'main') === ui.watch && !/^(agent|script)_/.test(str(r.entry.tool)));
  const box = $('working');
  const busy = running.length > 0 && conn.state === 'open';
  box.hidden = !busy;
  $('busybar').hidden = !busy;
  if (!busy) return;
  running.sort((a, b) => (parseTime(a.entry.startedAt) ?? 0) - (parseTime(b.entry.startedAt) ?? 0));
  const current = (running.find((r) => r.entry.status !== 'queued') ?? running[0]).entry;
  const queued = running.filter((r) => r.entry !== current).length;
  setText($('working-tool'), current.tool);
  const started = parseTime(current.startedAt);
  const elapsed = started === null ? '' : fmtDuration(Math.max(0, serverNow() - started));
  setText($('working-time'), `${elapsed}${queued ? ` · +${queued} queued` : ''}`);
}

function togglePause() {
  ui.paused = !ui.paused;
  const btn = $('btn-pause');
  btn.setAttribute('aria-pressed', String(ui.paused));
  setIcon(btn.querySelector('svg'), ui.paused ? 'play' : 'pause');
  setText(btn.querySelector('span'), ui.paused ? 'Resume' : 'Pause');
  btn.title = ui.paused ? 'Resume the live view (P)' : 'Pause the live view (P)';
  if (ui.paused) {
    live.pending = null;
    live.arrivals.length = 0;
    $('markers').replaceChildren();
  }
  if (conn.es) connect();
  mark('stage', 'framemeta', 'header');
}

function toggleFullscreen() {
  const panel = $('live-panel');
  const current = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (current) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  else (panel.requestFullscreen ?? panel.webkitRequestFullscreen)?.call(panel);
}

function onFullscreenChange() {
  const on = Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);
  const btn = $('btn-fullscreen');
  setIcon(btn.querySelector('svg'), on ? 'shrink' : 'expand');
  btn.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  stagePadding = null;
  requestAnimationFrame(resizeScreen);
}

// ------------------------------------------------------------------ activity

const act = {
  map: new Map(), // id -> { entry, el, refs, open }
  dirty: new Set(),
  running: new Set(),
  tools: new Set(),
  open: new Set(),
  filterTool: '',
  errorsOnly: false,
  toolOptionsSig: '',
};

function upsertActivity(entry, isLive) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return;
  const existing = act.map.get(entry.id);
  if (existing) existing.entry = entry;
  else {
    act.map.set(entry.id, { entry, el: null, refs: null, fresh: isLive });
    while (act.map.size > CAP.activity) {
      const [oldId, old] = act.map.entries().next().value;
      old.el?.remove();
      act.map.delete(oldId);
      act.dirty.delete(oldId);
      act.running.delete(oldId);
      act.open.delete(oldId);
    }
  }
  // queued calls live in the same set: the working pill shows the running one and counts the queued ones
  if (entry.status === 'running' || entry.status === 'queued') act.running.add(entry.id);
  else act.running.delete(entry.id);
  if (typeof entry.tool === 'string') act.tools.add(entry.tool);
  act.dirty.add(entry.id);
  mark('activity');
}

function splitToolName(tool) {
  const m = /^([a-z0-9]+_)(.+)$/i.exec(str(tool));
  return m ? [m[1], m[2]] : ['', str(tool)];
}

function argsSummary(args) {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return truncate(String(args), 200);
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  if (entries.length === 1 && typeof args.url === 'string') return truncate(args.url, 200);
  const fmt = (v) => {
    if (typeof v === 'string') return /^[\w@./:#?&=%+~-]+$/.test(v) && v.length < 80 ? v : JSON.stringify(truncate(v, 80));
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return truncate(JSON.stringify(v), 60);
    } catch {
      return '…';
    }
  };
  return truncate(entries.map(([k, v]) => `${k}: ${fmt(v)}`).join('  '), 240);
}

function buildActivityCard(rec) {
  const [prefix, rest] = splitToolName(rec.entry.tool);
  const refs = {
    status: h('span', { class: 'act-status' }),
    tool: h('span', { class: 'act-tool' }, h('span', { class: 'prefix', text: prefix }), rest),
    dur: h('span', { class: 'act-dur' }),
    summary: h('span', { class: 'act-summary' }),
    error: h('span', { class: 'act-error' }),
    meta: h('span', { class: 'act-meta' }),
    head: null,
    body: h('div', { class: 'act-body', hidden: true }),
  };
  refs.head = h(
    'button',
    { class: 'act-head', type: 'button', 'aria-expanded': 'false' },
    refs.status,
    h('span', { class: 'act-main' }, h('span', { class: 'act-line' }, refs.tool, refs.dur), refs.summary, refs.error, refs.meta),
    icon('chevron', 'act-chevron'),
  );
  const li = h('li', { class: `act${rec.fresh ? ' fresh' : ''}`, dataset: { id: rec.entry.id } }, refs.head, refs.body);
  refs.head.addEventListener('click', () => toggleActivity(rec));
  rec.refs = refs;
  rec.el = li;
  return li;
}

function toggleActivity(rec) {
  const id = rec.entry.id;
  if (act.open.has(id)) act.open.delete(id);
  else act.open.add(id);
  updateActivityCard(rec);
}

function updateActivityCard(rec) {
  const { entry, refs, el } = rec;
  const status = entry.status === 'ok' || entry.status === 'error' || entry.status === 'queued' ? entry.status : 'running';
  if (el.dataset.status !== status) {
    el.dataset.status = status;
    refs.status.replaceChildren(
      status === 'running' ? h('span', { class: 'spinner' }) : icon(status === 'ok' ? 'check' : status === 'queued' ? 'clock' : 'x'),
    );
    refs.status.title = { running: 'Running', queued: 'Queued: waiting for earlier tool calls', ok: 'Succeeded', error: 'Failed' }[status];
  }
  const started = parseTime(entry.startedAt);
  const duration = num(entry.durationMs) ?? (status === 'running' && started !== null ? Math.max(0, serverNow() - started) : null);
  setText(refs.dur, status === 'queued' ? 'queued' : duration === null ? '' : fmtDuration(duration));
  const queuedMs = num(entry.queuedMs);
  refs.dur.title = queuedMs ? `Waited ${fmtDuration(queuedMs)} in the queue before running` : '';
  setText(refs.summary, argsSummary(entry.args));
  const firstErrorLine = status === 'error' ? str(entry.error ?? entry.preview).split('\n').find((l) => l.trim()) ?? 'Failed' : '';
  setText(refs.error, firstErrorLine.replace(/^Error:\s*/, ''));
  refs.error.hidden = !firstErrorLine;
  el.classList.toggle('from-agent', Boolean(entry.agentRunId));
  refs.meta.replaceChildren(
    ...[fmtClock(entry.startedAt), entry.client ? str(entry.client) : null, entry.tabId ? str(entry.tabId) : null]
      .filter(Boolean)
      .flatMap((part, i) => (i ? [h('span', { class: 'sep', text: '·' }), part] : [part])),
  );
  refs.meta.title = [entry.client ? `Client: ${entry.client}` : null, entry.sessionId ? `Session: ${entry.sessionId}` : null, `Started: ${entry.startedAt ?? '?'}`]
    .filter(Boolean)
    .join('\n');

  const open = act.open.has(entry.id);
  refs.head.setAttribute('aria-expanded', String(open));
  if (open) el.dataset.open = '';
  else delete el.dataset.open;
  refs.body.hidden = !open;
  if (open) renderActivityBody(rec);
  else if (refs.body.firstChild) refs.body.replaceChildren();
}

function renderActivityBody(rec) {
  const { entry, refs } = rec;
  const signature = JSON.stringify([entry.status, entry.durationMs, entry.preview, entry.error, entry.url]);
  if (refs.body.dataset.sig === signature) return;
  refs.body.dataset.sig = signature;
  const parts = [];
  const hasArgs = entry.args && typeof entry.args === 'object' ? Object.keys(entry.args).length > 0 : entry.args !== undefined && entry.args !== null;
  parts.push(h('div', null, h('div', { class: 'act-label', text: 'Arguments' }), hasArgs ? jsonBlock(entry.args) : h('pre', { class: 'code', text: '(none)' })));
  if (entry.status === 'error') {
    parts.push(h('div', null, h('div', { class: 'act-label err', text: 'Error' }), h('pre', { class: 'code error', text: str(entry.error ?? entry.preview) || 'Failed' })));
  } else if (entry.status === 'ok') {
    parts.push(h('div', null, h('div', { class: 'act-label', text: 'Result' }), h('pre', { class: 'code', text: str(entry.preview) || '(empty result)' })));
  } else {
    parts.push(h('div', null, h('div', { class: 'act-label', text: 'Result' }), h('pre', { class: 'code', text: 'Running…' })));
  }
  const foot = [`call ${entry.id}`, entry.endedAt ? `ended ${fmtClock(entry.endedAt, true)}` : null, entry.url ? `page ${entry.url}` : null].filter(Boolean).join('  ·  ');
  parts.push(h('div', { class: 'act-foot', text: foot }));
  refs.body.replaceChildren(...parts);
}

function activityVisible(entry) {
  if (act.filterTool && entry.tool !== act.filterTool) return false;
  if (act.errorsOnly && entry.status !== 'error') return false;
  return true;
}

function renderActivity() {
  const list = $('activity-list');
  const stickTop = list.scrollTop < 8;
  for (const id of act.dirty) {
    const rec = act.map.get(id);
    if (!rec) continue;
    if (!rec.el) {
      buildActivityCard(rec);
      list.prepend(rec.el);
      if (rec.fresh) setTimeout(() => rec.el?.classList.remove('fresh'), 1000);
    }
    updateActivityCard(rec);
    rec.el.hidden = !activityVisible(rec.entry);
  }
  act.dirty.clear();
  if (stickTop) list.scrollTop = 0;
  renderActivityChrome();
  renderWorking();
}

function renderActivityChrome() {
  const total = act.map.size;
  let visible = 0;
  let errors = 0;
  for (const rec of act.map.values()) {
    if (rec.entry.status === 'error') errors++;
    if (activityVisible(rec.entry)) visible++;
  }
  const filtered = Boolean(act.filterTool || act.errorsOnly);
  const count = $('activity-count');
  setText(count, filtered ? `${visible}/${total}` : String(total));
  count.classList.toggle('err', errors > 0 && act.errorsOnly);
  count.title = `${total} tool calls, ${errors} failed`;

  const sig = [...act.tools].sort().join('\u0000');
  if (sig !== act.toolOptionsSig) {
    act.toolOptionsSig = sig;
    const select = $('activity-tool');
    const current = act.filterTool;
    select.replaceChildren(h('option', { value: '', text: 'All tools' }), ...[...act.tools].sort().map((t) => h('option', { value: t, text: t })));
    select.value = act.tools.has(current) ? current : '';
  }

  const empty = $('activity-empty');
  empty.hidden = visible > 0;
  if (!visible) {
    if (total) {
      setText($('activity-empty-title'), 'No matching tool calls');
      setText($('activity-empty-sub'), 'Change the filters to see more.');
    } else {
      setText($('activity-empty-title'), 'No tool calls yet');
      setText($('activity-empty-sub'), model.server?.mcpUrl ? `Connect an MCP client to ${model.server.mcpUrl} and ask it to browse. Every tool call shows up here.` : 'Connect an MCP client and ask it to browse. Every tool call shows up here.');
    }
  }
  $('activity-list').hidden = visible === 0;
}

function tickRunning() {
  if (!act.running.size) return;
  for (const id of act.running) {
    const rec = act.map.get(id);
    if (rec?.refs && rec.entry.status !== 'queued') {
      const started = parseTime(rec.entry.startedAt);
      if (started !== null) setText(rec.refs.dur, fmtDuration(Math.max(0, serverNow() - started)));
    }
  }
  renderWorking();
}

// ------------------------------------------------------------------ follow-scrolling lists

function follower(scroller, button) {
  const f = { on: true, intentAt: 0, pointerDown: false };
  const paint = () => button.setAttribute('aria-pressed', String(f.on));
  f.set = (on) => {
    if (f.on === on) return;
    f.on = on;
    paint();
    if (on) f.stick(true);
  };
  f.stick = (force = false) => {
    if ((!f.on && !force) || !scroller.clientHeight) return;
    scroller.scrollTop = scroller.scrollHeight;
  };
  // Only a real user scroll (wheel, touch, keys, scrollbar drag) turns following off;
  // scroll events caused by layout changes or row trimming must not.
  const intent = () => {
    f.intentAt = performance.now();
  };
  scroller.addEventListener('wheel', intent, { passive: true });
  scroller.addEventListener('touchmove', intent, { passive: true });
  document.addEventListener('keydown', (ev) => {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(ev.key)) intent();
  });
  scroller.addEventListener('pointerdown', () => {
    f.pointerDown = true;
    intent();
  });
  window.addEventListener('pointerup', () => {
    f.pointerDown = false;
  });
  scroller.addEventListener(
    'scroll',
    () => {
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX;
      const userScrolled = f.pointerDown || performance.now() - f.intentAt < 800;
      if (atBottom && !f.on && userScrolled) f.set(true);
      else if (!atBottom && f.on && userScrolled) {
        f.on = false;
        paint();
      }
    },
    { passive: true },
  );
  new ResizeObserver(() => f.stick()).observe(scroller);
  button.addEventListener('click', () => f.set(!f.on));
  paint();
  return f;
}

function isViewVisible(name) {
  return ui.view === name && !document.hidden;
}

// ------------------------------------------------------------------ console

const cons = {
  buf: [],
  seq: 0,
  lastRendered: 0,
  rebuild: true,
  clearedAt: '',
  level: store.get('console.level', 'all'),
  query: '',
  follow: null,
};

function consoleSeverity(level) {
  const l = str(level).toLowerCase();
  if (l === 'error' || l === 'exception' || l === 'assert') return 'error';
  if (l === 'warn' || l === 'warning') return 'warn';
  if (l === 'debug' || l === 'verbose' || l === 'trace') return 'debug';
  return 'log';
}

function addConsole(entries, fromHistory) {
  let items = entries.filter((e) => e && typeof e === 'object');
  if (cons.clearedAt) items = items.filter((e) => str(e.at) > cons.clearedAt);
  if (fromHistory) items = appendNewTimed(cons.buf, items, (e) => str(e.at), (e) => `${e.tabId}|${e.level}|${e.url}|${e.text}`);
  if (!items.length) return;
  for (const e of items) cons.buf.push({ ...e, _seq: ++cons.seq });
  if (cons.buf.length > CAP.console) cons.buf.splice(0, cons.buf.length - CAP.console);
  mark('console');
}

function consoleMatches(e) {
  const sev = consoleSeverity(e.level);
  if (cons.level === 'error' && sev !== 'error') return false;
  if (cons.level === 'warn' && sev !== 'error' && sev !== 'warn') return false;
  if (cons.query && !`${str(e.text)} ${str(e.url)}`.toLowerCase().includes(cons.query)) return false;
  return true;
}

function consoleRow(e) {
  const sev = consoleSeverity(e.level);
  const src = str(e.url);
  let srcLabel = '';
  if (src) {
    const parts = splitUrl(src);
    srcLabel = parts.host ? `${parts.rest.split('/').filter(Boolean).pop() || parts.host}` : truncate(src, 40);
  }
  return h(
    'div',
    { class: `row con-row is-${sev}`, dataset: { seq: String(e._seq) }, hidden: !consoleMatches(e) },
    h('span', { class: 'c-time', text: fmtClock(e.at), title: str(e.at) }),
    h('span', { class: `lvl lvl-${str(e.level).toLowerCase().replace(/[^a-z]/g, '') || 'log'}`, text: str(e.level) || 'log' }),
    h('span', { class: 'con-msg', text: str(e.text) }),
    h('span', { class: 'con-src cell-ellipsis', text: srcLabel, title: src ? `${src}${e.tabId ? `\n${e.tabId}` : ''}` : str(e.tabId) }),
  );
}

function renderConsole() {
  const list = $('console-rows');
  const first = cons.buf[0]?._seq ?? cons.seq + 1;
  if (cons.rebuild) {
    cons.rebuild = false;
    list.replaceChildren();
    cons.lastRendered = first - 1;
  }
  while (list.firstElementChild && Number(list.firstElementChild.dataset.seq) < first) list.firstElementChild.remove();
  const start = Math.max(0, cons.lastRendered - first + 1);
  if (start < cons.buf.length) {
    const frag = document.createDocumentFragment();
    for (let i = start; i < cons.buf.length; i++) frag.append(consoleRow(cons.buf[i]));
    list.append(frag);
    cons.lastRendered = cons.buf[cons.buf.length - 1]._seq;
  }
  let visible = 0;
  let errors = 0;
  let warns = 0;
  for (const e of cons.buf) {
    const sev = consoleSeverity(e.level);
    if (sev === 'error') errors++;
    else if (sev === 'warn') warns++;
  }
  for (const row of list.children) if (!row.hidden) visible++;
  const count = $('count-console');
  setText(count, String(cons.buf.length));
  count.classList.toggle('err', errors > 0);
  count.classList.toggle('warn', errors === 0 && warns > 0);
  count.title = `${cons.buf.length} messages, ${errors} errors, ${warns} warnings`;
  const empty = $('console-empty');
  empty.hidden = visible > 0;
  setText(empty, cons.buf.length ? 'No console messages match the filters.' : 'No console output yet. Page console messages and uncaught errors appear here.');
  if (isViewVisible('console')) cons.follow.stick();
}

function refilterConsole() {
  const list = $('console-rows');
  const first = cons.buf[0]?._seq ?? 0;
  for (const row of list.children) {
    const e = cons.buf[Number(row.dataset.seq) - first];
    if (e) row.hidden = !consoleMatches(e);
  }
  mark('console');
}

// ------------------------------------------------------------------ network

const net = {
  map: new Map(), // key -> { entry, el }
  dirty: new Set(),
  rebuild: true,
  clearedAt: '',
  query: '',
  type: '',
  failedOnly: false,
  follow: null,
};

const netKey = (e) => `${str(e.tabId)}\u0000${str(e.requestId)}`;

function upsertNetwork(entry) {
  if (!entry || typeof entry !== 'object' || !entry.requestId) return;
  const key = netKey(entry);
  const rec = net.map.get(key);
  if (rec) rec.entry = entry;
  else {
    if (net.clearedAt && str(entry.startedAt) <= net.clearedAt) return;
    net.map.set(key, { entry, el: null });
    while (net.map.size > CAP.network) {
      const [oldKey, old] = net.map.entries().next().value;
      old.el?.remove();
      net.map.delete(oldKey);
      net.dirty.delete(oldKey);
    }
  }
  net.dirty.add(key);
  mark('network');
}

function networkTypeGroup(type) {
  switch (str(type).toLowerCase()) {
    case 'document':
      return 'doc';
    case 'xhr':
    case 'fetch':
    case 'eventsource':
    case 'websocket':
      return 'xhr';
    case 'script':
      return 'script';
    case 'stylesheet':
      return 'css';
    case 'image':
    case 'media':
      return 'img';
    case 'font':
      return 'font';
    default:
      return 'other';
  }
}

const isFailed = (e) => num(e.status) !== null && e.status >= 400;

function networkMatches(e) {
  if (net.failedOnly && !isFailed(e)) return false;
  if (net.type && networkTypeGroup(e.resourceType) !== net.type) return false;
  if (net.query && !str(e.url).toLowerCase().includes(net.query)) return false;
  return true;
}

function fillNetworkRow(row, e) {
  const pending = e.state !== 'done';
  const failed = isFailed(e);
  const status = num(e.status);
  row.className = `row net-row${failed ? ' is-failed' : ''}${pending && status === null ? ' is-pending' : ''}`;
  row.hidden = !networkMatches(e);
  const parts = splitUrl(e.url);
  const statusCls = status === null ? 's-pending' : status >= 400 ? 's-fail' : status >= 300 ? 's-redirect' : 's-ok';
  row.replaceChildren(
    h('span', { class: `status ${statusCls}`, text: status === null ? (pending ? '…' : '–') : String(status), title: status === null ? (pending ? 'Pending' : 'No response status') : `HTTP ${status}` }),
    h('span', { class: 'c-method', text: str(e.method) }),
    h('span', { class: 'c-type cell-ellipsis', text: str(e.resourceType), title: e.mimeType ? str(e.mimeType) : undefined }),
    h(
      'span',
      { class: 'net-url cell-ellipsis', title: `${str(e.method)} ${str(e.url)}${e.initiator ? `\ninitiator: ${e.initiator}` : ''}\n${str(e.tabId)}` },
      parts.host ? h('span', { class: 'u-host', text: parts.host }) : null,
      h('span', { class: 'u-path', text: parts.rest }),
    ),
    h('span', { class: 'c-size num', text: pending ? '' : fmtBytes(num(e.size)) }),
    h('span', {
      class: 'c-dur num',
      text: pending ? 'pending' : fmtDuration(num(e.durationMs)) || '–',
      title: pending || num(e.durationMs) !== null ? '' : 'Duration not reported by the browser engine for this request',
    }),
    h('span', { class: 'c-start num c-time', text: fmtClock(e.startedAt), title: str(e.startedAt) }),
  );
}

function renderNetwork() {
  const list = $('network-rows');
  if (net.rebuild) {
    net.rebuild = false;
    list.replaceChildren();
    for (const [key, rec] of net.map) {
      rec.el = null;
      net.dirty.add(key);
    }
  }
  if (net.dirty.size) {
    const frag = document.createDocumentFragment();
    for (const key of net.dirty) {
      const rec = net.map.get(key);
      if (!rec) continue;
      if (!rec.el) {
        rec.el = h('div');
        frag.append(rec.el);
      }
      fillNetworkRow(rec.el, rec.entry);
    }
    net.dirty.clear();
    list.append(frag);
  }
  let visible = 0;
  let failed = 0;
  let pending = 0;
  let bytes = 0;
  for (const { entry, el } of net.map.values()) {
    if (el && !el.hidden) visible++;
    if (isFailed(entry)) failed++;
    if (entry.state !== 'done') pending++;
    bytes += num(entry.size) ?? 0;
  }
  const count = $('count-network');
  setText(count, String(net.map.size));
  count.classList.toggle('err', failed > 0);
  count.title = `${net.map.size} requests, ${failed} failed`;
  const empty = $('network-empty');
  empty.hidden = visible > 0;
  setText(empty, net.map.size ? 'No requests match the filters.' : 'No requests yet. Network activity of the agent’s pages appears here.');
  const foot = $('network-foot');
  if (net.map.size) {
    foot.replaceChildren(...[
      h('span', null, h('b', { text: String(net.map.size) }), ' requests'),
      h('span', null, h('b', { text: fmtBytes(bytes) || '0 B' }), ' transferred'),
      failed ? h('span', { class: 'err' }, h('b', { text: String(failed) }), ' failed') : null,
      pending ? h('span', null, h('b', { text: String(pending) }), ' pending') : null,
      visible !== net.map.size ? h('span', null, h('b', { text: String(visible) }), ' shown') : null,
    ].filter(Boolean));
  } else foot.replaceChildren();
  if (isViewVisible('network')) net.follow.stick();
}

function refilterNetwork() {
  for (const { entry, el } of net.map.values()) if (el) el.hidden = !networkMatches(entry);
  mark('network');
}

// ------------------------------------------------------------------ logs

const logs = {
  buf: [],
  seq: 0,
  lastRendered: 0,
  rebuild: true,
  minLevel: store.get('logs.level', 'info'),
  component: '',
  query: '',
  components: new Set(),
  componentsSig: '',
  open: new Set(),
  warns: 0,
  errors: 0,
  follow: null,
};

function countLog(rec, delta) {
  const lvl = num(rec.r.level) ?? 30;
  if (lvl >= 50) logs.errors += delta;
  else if (lvl >= 40) logs.warns += delta;
}

function addLogs(records, fromHistory) {
  let items = records.filter((r) => r && typeof r === 'object');
  // logs.buf holds wrappers ({ r, seq, ... }); compare the raw records, which serialize identically
  if (fromHistory) items = appendNewTimed(logs.buf, items, (r) => str(r.time), (r) => JSON.stringify(r), (rec) => rec.r);
  if (!items.length) return;
  for (const r of items) {
    const rec = { r, seq: ++logs.seq, hay: null, details: undefined };
    logs.buf.push(rec);
    countLog(rec, 1);
    if (typeof r.component === 'string') logs.components.add(r.component);
  }
  if (logs.buf.length > CAP.logBuffer) {
    const removed = logs.buf.splice(0, logs.buf.length - CAP.logBuffer);
    for (const rec of removed) {
      logs.open.delete(rec.seq);
      countLog(rec, -1);
    }
  }
  mark('logs');
}

function logLevelName(r) {
  if (typeof r.levelName === 'string') return r.levelName.toLowerCase();
  const n = num(r.level);
  if (n === null) return 'info';
  return Object.entries(LEVEL_VALUE).reduce((best, [name, v]) => (n >= v ? name : best), 'trace');
}

function logDetails(rec) {
  if (rec.details !== undefined) return rec.details;
  const details = {};
  let any = false;
  for (const [k, v] of Object.entries(rec.r)) {
    if (LOG_DETAIL_SKIP.has(k)) continue;
    details[k] = v;
    any = true;
  }
  rec.details = any ? details : null;
  return rec.details;
}

function logMatches(rec) {
  const r = rec.r;
  const value = num(r.level) ?? LEVEL_VALUE[logLevelName(r)] ?? 30;
  if (value < (LEVEL_VALUE[logs.minLevel] ?? 30)) return false;
  if (logs.component && r.component !== logs.component) return false;
  if (logs.query) {
    if (rec.hay === null) {
      let detailText = '';
      try {
        detailText = JSON.stringify(logDetails(rec)) ?? '';
      } catch {
        detailText = '';
      }
      rec.hay = `${str(r.msg)} ${str(r.component)} ${detailText}`.toLowerCase();
    }
    if (!rec.hay.includes(logs.query)) return false;
  }
  return true;
}

function logRow(rec) {
  const r = rec.r;
  const level = logLevelName(r);
  const details = logDetails(rec);
  const component = str(r.component);
  const row = h(
    'div',
    { class: `row log-row lvl-row-${level}${details ? ' has-details' : ''}`, dataset: { seq: String(rec.seq) } },
    h('span', { class: 'c-time', text: fmtClock(r.time, true), title: str(r.time) }),
    h('span', { class: `lvl lvl-${level}`, text: level }),
    h('span', { class: 'log-comp', style: { '--hue': String(hashHue(component || 'none')) }, text: component || '–', title: component || undefined }),
    h('span', { class: 'log-msg', text: str(r.msg), title: str(r.msg).length > 80 ? str(r.msg) : undefined }),
    details ? icon('chevron', 'log-caret') : h('span'),
  );
  if (details && logs.open.has(rec.seq)) openLogRow(row, rec);
  return row;
}

function openLogRow(row, rec) {
  row.classList.add('open');
  const block = jsonBlock(logDetails(rec), 'log-details');
  block.addEventListener('click', (ev) => ev.stopPropagation());
  row.append(block);
}

function renderLogs() {
  const list = $('logs-rows');
  const buf = logs.buf;
  const firstSeq = buf[0]?.seq ?? logs.seq + 1;
  const newStart = Math.max(0, logs.lastRendered - firstSeq + 1);
  let newMatches = null;
  if (!logs.rebuild) {
    newMatches = [];
    for (let i = newStart; i < buf.length; i++) if (logMatches(buf[i])) newMatches.push(buf[i]);
    if (newMatches.length > CAP.logRows) logs.rebuild = true;
  }
  if (logs.rebuild) {
    logs.rebuild = false;
    const picked = [];
    for (let i = buf.length - 1; i >= 0 && picked.length < CAP.logRows; i--) if (logMatches(buf[i])) picked.push(buf[i]);
    picked.reverse();
    const frag = document.createDocumentFragment();
    for (const rec of picked) frag.append(logRow(rec));
    list.replaceChildren(frag);
  } else {
    while (list.firstElementChild && Number(list.firstElementChild.dataset.seq) < firstSeq) list.firstElementChild.remove();
    if (newMatches.length) {
      const frag = document.createDocumentFragment();
      for (const rec of newMatches) frag.append(logRow(rec));
      list.append(frag);
    }
    while (list.childElementCount > CAP.logRows) list.firstElementChild.remove();
  }
  logs.lastRendered = buf.length ? buf[buf.length - 1].seq : logs.seq;

  const { warns, errors } = logs;
  const count = $('count-logs');
  setText(count, list.childElementCount >= CAP.logRows ? `${CAP.logRows}+` : String(list.childElementCount));
  count.classList.toggle('err', errors > 0);
  count.classList.toggle('warn', errors === 0 && warns > 0);
  count.title = `${list.childElementCount} lines shown (${buf.length} buffered), ${errors} errors, ${warns} warnings`;
  $('logs-empty').hidden = list.childElementCount > 0;

  const sig = [...logs.components].sort().join('\u0000');
  if (sig !== logs.componentsSig) {
    logs.componentsSig = sig;
    const select = $('logs-component');
    const current = logs.component;
    select.replaceChildren(h('option', { value: '', text: 'All components' }), ...[...logs.components].sort().map((c) => h('option', { value: c, text: c })));
    select.value = logs.components.has(current) ? current : '';
  }
  if (isViewVisible('logs')) logs.follow.stick();
}

function onLogsClick(ev) {
  const row = ev.target.closest('.log-row.has-details');
  if (!row || !$('logs-rows').contains(row)) return;
  if (String(window.getSelection?.() ?? '').length > 0) return;
  const seq = Number(row.dataset.seq);
  const rec = logs.buf.find((r) => r.seq === seq);
  if (!rec) return;
  if (logs.open.has(seq)) {
    logs.open.delete(seq);
    row.classList.remove('open');
    row.querySelector('.log-details')?.remove();
  } else {
    logs.open.add(seq);
    openLogRow(row, rec);
  }
}

// ------------------------------------------------------------------ sessions

function renderSessions() {
  const list = $('sessions-rows');
  const sessions = [...model.sessions].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
  const now = serverNow();
  list.replaceChildren(
    ...sessions.map((s) => {
      const created = parseTime(s.createdAt);
      const seen = parseTime(s.lastSeenAt);
      const recent = seen !== null && now - seen < 60_000;
      return h(
        'div',
        { class: 'row sess-row' },
        h(
          'span',
          { class: 'sess-client', title: s.userAgent ? `User agent: ${s.userAgent}` : undefined },
          h('span', { class: 'sess-name', text: s.client || 'Unnamed client' }),
          h('span', { class: 'sess-id', text: str(s.id).slice(0, 8), title: str(s.id) }),
        ),
        h('span', { class: 'c-proto mono muted', text: s.protocolVersion || '–' }),
        h('span', { class: 'c-since muted', text: created === null ? '–' : fmtAgo(now - created), title: s.createdAt ? new Date(s.createdAt).toLocaleString() : undefined }),
        h('span', { class: 'muted', title: s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : undefined }, h('span', { class: `fresh-dot${recent ? ' on' : ''}` }), seen === null ? '–' : fmtAgo(now - seen)),
        h('span', { class: 'num', text: String(num(s.toolCalls) ?? 0) }),
        h('span', { class: 'c-addr mono muted cell-ellipsis', text: str(s.remoteAddress) || '–' }),
      );
    }),
  );
  $('sessions-empty').hidden = sessions.length > 0;
  setText($('sessions-empty'), model.server?.mcpUrl ? `No MCP clients connected. Point a client at ${model.server.mcpUrl}` : 'No MCP clients connected.');
  setText($('count-sessions'), String(sessions.length));

  const foot = $('server-foot');
  const server = model.server;
  const browser = model.browser;
  if (server || browser) {
    const item = (label, value) => h('span', null, `${label} `, h('b', { text: value }));
    foot.replaceChildren(
      ...[
        browser?.viewport ? item('Viewport', `${browser.viewport.width}×${browser.viewport.height}`) : null,
        server?.toolsets ? item('Toolsets', [].concat(server.toolsets).join(', ')) : null,
        server ? item('Auth', server.authRequired ? 'token required' : 'off') : null,
        browser ? item('Proxy', browser.proxy ? 'configured' : 'none') : null,
        browser ? item('Private network', browser.allowPrivateNetwork ? 'allowed' : 'blocked') : null,
        server?.logFile ? item('Log file', server.logFile) : null,
      ].filter(Boolean),
    );
  }
}

// ------------------------------------------------------------------ browsers + sub-agents

function watchInfo() {
  return model.browsers.find((b) => b.id === ui.watch) ?? null;
}

/** Watching the (discarded) browser of a finished run: only its last frame remains. */
function watchingClosed() {
  const info = watchInfo();
  return Boolean(info && info.kind !== 'main' && info.status === 'closed');
}

function switchBrowser(id) {
  id = str(id) || 'main';
  if (id === ui.watch) return;
  ui.watch = id;
  store.set('watch', id);
  // everything browser-specific comes again from the new stream's 'hello'
  resetData();
  model.tabs = [];
  model.activeTabId = null;
  model.tabsSignature = '';
  model.browser = null; // the previous browser's state must not show until the new one's arrives
  mark('tabs', 'stage', 'framemeta', 'browsers', 'header');
  connect();
}

const KIND_LABEL = { task: 'Agentic', automation: 'Automation', finder: 'Finder' };

function browserLabel(b) {
  if (b.kind === 'main') return 'Main browser';
  const run = b.runId ? model.agents.get(b.runId) : null;
  const status = b.status === 'closed' ? 'closed' : run ? run.status : 'running';
  return `${b.label} · ${status}`;
}

function renderBrowsers() {
  const select = $('browser-select');
  const list = model.browsers.length ? model.browsers : [{ id: 'main', kind: 'main', label: 'Main browser', status: 'open' }];
  const options = list.map((b) => [b.id, browserLabel(b)]);
  if (!options.some(([id]) => id === ui.watch)) options.push([ui.watch, ui.watch]);
  const sig = JSON.stringify(options);
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(...options.map(([id, label]) => h('option', { value: id, text: label })));
  }
  if (select.value !== ui.watch) select.value = ui.watch;
  const others = list.filter((b) => b.kind !== 'main' && b.status === 'open').length;
  $('browser-pick').classList.toggle('has-others', others > 0);
  $('browser-pick').classList.toggle('watching-other', ui.watch !== 'main');
}

const agentsUi = {
  open: new Set(),
  details: new Map(), // run id -> { data, loadedAt, loading }
};

function upsertAgent(summary) {
  if (!summary || typeof summary !== 'object' || typeof summary.id !== 'string') return;
  const previous = model.agents.get(summary.id);
  model.agents.set(summary.id, summary);
  while (model.agents.size > 100) model.agents.delete(model.agents.keys().next().value);
  if (agentsUi.open.has(summary.id) && (!previous || previous.step !== summary.step || previous.status !== summary.status || previous.transcript !== summary.transcript)) {
    void loadAgentDetails(summary.id);
  }
  if (previous && previous.status !== summary.status && ['completed', 'failed', 'cancelled'].includes(summary.status)) void loadScripts();
  mark('agents', 'browsers');
}

async function loadAgentDetails(id) {
  const rec = agentsUi.details.get(id) ?? { data: null, loadedAt: 0, loading: false };
  agentsUi.details.set(id, rec);
  if (rec.loading) {
    rec.stale = true; // fetch again when the current request is done
    return;
  }
  rec.loading = true;
  rec.stale = false;
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) {
      rec.data = await res.json();
      rec.loadedAt = Date.now();
      rec.failed = false;
    } else {
      rec.failed = true;
    }
  } catch {
    rec.failed = true; // keep the previous details
  } finally {
    rec.loading = false;
    mark('agents');
    if (rec.stale) void loadAgentDetails(id);
  }
}

async function loadScripts() {
  model.scriptsLoadedAt = Date.now();
  try {
    const res = await fetch('/api/scripts', { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) {
      const body = await res.json();
      model.scripts = Array.isArray(body.scripts) ? body.scripts : [];
      mark('agents');
    }
  } catch {
    // retried on the next tick
  }
}

function onAgentsClick(ev) {
  const btn = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
  if (!btn) return;
  const id = btn.dataset.run;
  if (btn.dataset.action === 'watch' && btn.dataset.browser) {
    switchBrowser(btn.dataset.browser);
  } else if (btn.dataset.action === 'details' && id) {
    if (agentsUi.open.has(id)) agentsUi.open.delete(id);
    else {
      agentsUi.open.add(id);
      void loadAgentDetails(id);
    }
    mark('agents');
  }
}

function statusTone(a) {
  if (a.status === 'running') return 'live';
  if (a.status === 'queued') return 'warn';
  if (a.status === 'completed') return a.success === false ? 'warn' : 'ok';
  if (a.status === 'failed') return 'err';
  return 'muted';
}

function safeLink(url, text) {
  const u = str(url);
  return /^https?:\/\//i.test(u) ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: text ?? u }) : h('span', { text: text ?? u });
}

function agentDetailsBlock(id) {
  const rec = agentsUi.details.get(id);
  if (!rec?.data) return h('div', { class: 'agent-details muted', text: rec?.loading ? 'Loading…' : rec?.failed ? 'Could not load the details of this run (it may have left the server’s history).' : 'No details yet.' });
  const d = rec.data;
  const parts = [];
  parts.push(h('div', { class: 'act-label', text: d.summary?.kind === 'finder' ? 'Objective' : 'Task' }), h('pre', { class: 'code', dataset: { key: 'task' }, text: str(d.input?.task) }));
  parts.push(h('div', { class: 'act-label', text: 'Requested output' }), h('pre', { class: 'code', dataset: { key: 'output' }, text: str(d.input?.output) }));
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (steps.length) {
    parts.push(h('div', { class: 'act-label', text: `Steps (${steps.length}${d.summary?.step > steps.length ? ` of ${d.summary.step}` : ''})` }));
    parts.push(
      h(
        'ol',
        { class: 'agent-steps' },
        ...steps.map((st) =>
          h(
            'li',
            { dataset: { step: String(st.step) } },
            h(
              'div',
              { class: 'agent-step-head' },
              h('b', { text: `#${st.step}` }),
              h('span', { class: 'muted', text: `model ${fmtDuration(st.llmMs)}${st.promptTokens ? ` · ${st.promptTokens} prompt tokens` : ''}` }),
            ),
            st.reasoning ? h('details', null, h('summary', { text: 'Reasoning' }), h('pre', { class: 'code', dataset: { key: `reasoning-${st.step}` }, text: str(st.reasoning) })) : null,
            st.content ? h('pre', { class: 'code', dataset: { key: `content-${st.step}` }, text: str(st.content) }) : null,
            ...(Array.isArray(st.toolCalls) ? st.toolCalls : []).map((c) =>
              h(
                'div',
                { class: `agent-call ${c.ok ? 'ok' : 'err'}` },
                icon(c.ok ? 'check' : 'x'),
                h('span', { class: 'agent-call-name', text: str(c.name) }),
                h('span', { class: 'agent-call-args', text: argsSummary(c.args) }),
                h('div', { class: 'agent-call-preview', text: truncate(str(c.preview), 300) }),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (Array.isArray(d.sources) && d.sources.length) {
    parts.push(h('div', { class: 'act-label', text: 'Sources' }));
    parts.push(
      h(
        'ol',
        { class: 'agent-sources' },
        ...d.sources.map((src) =>
          h(
            'li',
            null,
            safeLink(src.url, str(src.title) || str(src.url)),
            ...(Array.isArray(src.quotes) ? src.quotes : []).map((q) => h('div', { class: `agent-quote${q.verified ? '' : ' unverified'}`, text: `“${truncate(str(q.text), 300)}”${q.verified ? '' : ' (not verified on the page)'}` })),
          ),
        ),
      ),
    );
  }
  if (Array.isArray(d.notes) && d.notes.length) {
    parts.push(h('div', { class: 'act-label', text: 'Notes' }), h('pre', { class: 'code', dataset: { key: 'notes' }, text: d.notes.map((n, i) => `${i + 1}. ${n}`).join('\n') }));
  }
  if (d.outcome) {
    const block = jsonBlock(d.outcome);
    block.dataset.key = 'outcome';
    parts.push(h('div', { class: 'act-label', text: 'Result' }), block);
  }
  if (d.error) parts.push(h('div', { class: 'act-label err', text: 'Error' }), h('pre', { class: 'code error', dataset: { key: 'error' }, text: str(d.error) }));
  if (d.transcript) parts.push(h('div', { class: 'act-foot', text: `Transcript: ${d.transcript}` }));
  return h('div', { class: 'agent-details' }, ...parts);
}

function agentElapsed(a) {
  const started = parseTime(a.startedAt);
  if (started === null) return null;
  const ended = parseTime(a.endedAt);
  return Math.max(0, (ended ?? serverNow()) - started);
}

function agentMetaText(a) {
  const elapsed = agentElapsed(a);
  return [a.status === 'queued' ? null : `step ${a.step ?? 0}/${a.maxSteps ?? '?'}`, elapsed === null ? null : fmtDuration(elapsed), a.client ? str(a.client) : null]
    .filter(Boolean)
    .join(' · ');
}

function buildAgentCard(a) {
  const open = agentsUi.open.has(a.id);
  const browser = (a.browserId && model.browsers.find((b) => b.id === a.browserId)) || (a.status === 'running' && a.browserId);
  const watching = Boolean(a.browserId) && ui.watch === a.browserId;
  const statusText = a.status === 'completed' ? (a.success === false ? 'completed · no success' : 'completed') : a.status;
  return h(
    'div',
    { class: `agent-card${open ? ' open' : ''}`, dataset: { id: a.id } },
    h(
      'div',
      { class: 'agent-head' },
      h('span', { class: `agent-kind kind-${str(a.kind)}`, text: KIND_LABEL[a.kind] ?? str(a.kind) }),
      h('span', { class: 'pill agent-status', dataset: { tone: statusTone(a) } }, h('span', { class: 'dot' }), h('span', { class: 'pill-text', text: statusText })),
      h('span', { class: 'agent-id mono', text: a.id }),
      h('span', { class: 'agent-meta muted', dataset: { run: a.id }, text: agentMetaText(a) }),
      h(
        'span',
        { class: 'agent-actions' },
        a.browserId
          ? h(
              'button',
              {
                class: `chip${watching ? ' on' : ''}`,
                type: 'button',
                dataset: { action: 'watch', browser: a.browserId, run: a.id },
                'aria-pressed': String(watching),
                disabled: browser ? undefined : true,
                title: browser ? 'Show this agent\'s browser in the live view' : 'Its browser is no longer listed',
              },
              icon('eye'),
              watching ? 'Watching' : 'Watch',
            )
          : null,
        h('button', { class: 'chip', type: 'button', dataset: { action: 'details', run: a.id }, 'aria-expanded': String(open) }, icon('chevron', open ? 'rot' : ''), 'Details'),
      ),
    ),
    h('div', { class: 'agent-task', text: truncate(str(a.task), 400), title: str(a.task) }),
    a.status === 'running' || a.status === 'queued' ? h('div', { class: 'agent-activity' }, h('span', { class: 'spinner' }), h('span', { class: 'agent-activity-text', text: truncate(str(a.activity), 200) })) : null,
    a.status === 'running' && a.thinking ? h('div', { class: 'agent-thinking', text: `… ${str(a.thinking).slice(-400)}` }) : null,
    a.script
      ? h('div', { class: 'agent-script' }, icon('script'), h('span', { text: `Script ${str(a.script.name)} v${a.script.version}${a.script.lastTest === true ? ' · last test passed' : a.script.lastTest === false ? ' · last test failed' : ''}` }))
      : null,
    a.result ? h('div', { class: 'agent-result', text: truncate(str(a.result), 500) }) : null,
    a.error ? h('div', { class: 'agent-error', text: str(a.error) }) : null,
    open ? agentDetailsBlock(a.id) : null,
  );
}

/** Everything a card shows except its elapsed time (that ticks in place, see tickAgents). */
function agentCardSig(a) {
  const browser = a.browserId && model.browsers.find((b) => b.id === a.browserId);
  return JSON.stringify([
    a.status, a.success, a.step, a.maxSteps, Boolean(a.thinking), a.result, a.error, a.script, a.task, a.client, a.kind,
    agentsUi.open.has(a.id), agentsUi.details.get(a.id)?.loadedAt ?? 0, agentsUi.details.get(a.id)?.loading ?? false, agentsUi.details.get(a.id)?.failed ?? false,
    ui.watch === a.browserId, Boolean(browser),
  ]);
}

/** The fields that change while the model streams are updated in place (no rebuild). */
function patchAgentCard(card, a) {
  const activity = card.querySelector('.agent-activity-text');
  if (activity) setText(activity, truncate(str(a.activity), 200));
  const thinking = card.querySelector('.agent-thinking');
  if (thinking) setText(thinking, `… ${str(a.thinking).slice(-400)}`);
  return card;
}

/** Refresh the elapsed time of running cards without rebuilding them. */
function tickAgents() {
  for (const el of $('agents-rows').querySelectorAll('.agent-meta[data-run]')) {
    const a = model.agents.get(el.dataset.run);
    if (a && (a.status === 'running' || a.status === 'queued')) setText(el, agentMetaText(a));
  }
}

function renderAgents() {
  const runs = [...model.agents.values()].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
  const box = $('agents-rows');
  // one card per run, rebuilt only when that run's data changed (keeps focus, selection and open sections)
  const existing = new Map([...box.children].map((el) => [el.dataset.id, el]));
  const wanted = runs.map((a) => {
    const sig = agentCardSig(a);
    const old = existing.get(a.id);
    if (old && old.dataset.sig === sig) return patchAgentCard(old, a);
    const card = buildAgentCard(a);
    card.dataset.sig = sig;
    if (old) {
      // keep open reasoning sections and scroll positions of the details, matched by step and block
      const openSteps = new Set([...old.querySelectorAll('.agent-steps > li')].filter((li) => li.querySelector('details[open]')).map((li) => li.dataset.step));
      for (const li of card.querySelectorAll('.agent-steps > li')) {
        const d = li.querySelector('details');
        if (d && openSteps.has(li.dataset.step)) d.open = true;
      }
      const scrolls = new Map([...old.querySelectorAll('.code[data-key]')].map((c) => [c.dataset.key, c.scrollTop]));
      const focused = old.contains(document.activeElement) ? document.activeElement?.dataset?.action : null;
      old.replaceWith(card);
      // scroll positions apply once the card is in the document
      for (const c of card.querySelectorAll('.code[data-key]')) {
        const top = scrolls.get(c.dataset.key);
        if (top) c.scrollTop = top;
      }
      if (focused) card.querySelector(`[data-action="${focused}"]`)?.focus();
    }
    return patchAgentCard(card, a);
  });
  for (const [id, el] of existing) if (!model.agents.has(id)) el.remove();
  wanted.forEach((card, i) => {
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] ?? null);
  });

  const info = model.agentsInfo;
  $('agents-empty').hidden = runs.length > 0;
  setText(
    $('agents-empty'),
    info && info.enabled === false
      ? 'Sub-agents are off: add config/models.json (or set AGENT_LLM_URL) with an OpenAI-compatible model to enable agent_run, agent_automate and agent_find.'
      : 'No agent runs yet. The host agent starts them with agent_run, agent_automate or agent_find.',
  );
  const running = runs.filter((a) => a.status === 'running').length;
  const queued = runs.filter((a) => a.status === 'queued').length;
  const count = $('count-agents');
  setText(count, running || queued ? [running ? `${running} running` : null, queued ? `${queued} queued` : null].filter(Boolean).join(' · ') : String(runs.length));
  count.classList.toggle('warn', running + queued > 0);

  const scripts = model.scripts.filter((sc) => sc && typeof sc === 'object');
  const rowsEl = $('scripts-rows');
  const scriptsSig = JSON.stringify(scripts);
  if (rowsEl.dataset.sig !== scriptsSig) {
    rowsEl.dataset.sig = scriptsSig;
    rowsEl.replaceChildren(
      ...scripts.map((sc) =>
        h(
          'div',
          { class: 'script-row' },
          h('span', { class: 'script-name mono', text: `${str(sc.name)} v${sc.version}` }),
          h('span', { class: 'pill', dataset: { tone: sc.verification?.status === 'passed' ? 'ok' : sc.verification?.status === 'failed' ? 'err' : 'muted' } }, h('span', { class: 'pill-text', text: `verification ${str(sc.verification?.status ?? 'not_run')}` })),
          h('span', { class: 'muted', text: `${sc.runs ?? 0} run${sc.runs === 1 ? '' : 's'}` }),
          h('span', {
            class: 'script-params mono',
            text:
              (Array.isArray(sc.params) ? sc.params : [])
                .filter((p) => p && typeof p === 'object')
                .map((p) => `${str(p.name)}${p.required ? '' : '?'}: ${str(p.type)}`)
                .join(', ') || 'no parameters',
          }),
          h('span', { class: 'script-desc', text: str(sc.description) }),
        ),
      ),
    );
  }
  $('scripts-empty').hidden = scripts.length > 0;
  setText($('count-scripts'), String(scripts.length));
  const foot = $('agents-foot');
  const footSig = JSON.stringify(info ?? null);
  if (info && foot.dataset.sig !== footSig) {
    foot.dataset.sig = footSig;
    const item = (label, value) => h('span', null, `${label} `, h('b', { text: value }));
    foot.replaceChildren(
      ...[
        item('Agents', info.enabled ? 'on' : 'off'),
        info.enabled ? item('Model', str(info.model) || '(first listed)') : null,
        info.enabled && info.config ? item('Config', str(info.config)) : null,
        info.enabled && info.endpoint ? item('Endpoint', str(info.endpoint)) : null,
        info.enabled ? item('Context', `${Math.round((info.contextTokens ?? 0) / 1024)}k tokens`) : null,
        info.enabled ? item('Running', `${info.running ?? 0}/${info.maxConcurrent ?? '?'}${info.queued ? ` (+${info.queued} queued)` : ''}`) : null,
        info.scriptsDir ? item('Scripts', str(info.scriptsDir)) : null,
      ].filter(Boolean),
    );
  }
}

// ------------------------------------------------------------------ inspector tabs + splitter

function selectView(name) {
  if (!['console', 'network', 'logs', 'sessions', 'agents'].includes(name)) name = 'console';
  ui.view = name;
  store.set('view', name);
  for (const tab of document.querySelectorAll('.itab')) {
    const selected = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const tools of document.querySelectorAll('.view-tools')) tools.hidden = tools.dataset.for !== name;
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  const follow = { console: cons.follow, network: net.follow, logs: logs.follow }[name];
  if (follow) requestAnimationFrame(() => follow.stick());
  if (name === 'agents') void loadScripts();
  mark(name);
}

function applySplit(pct) {
  ui.split = Math.min(82, Math.max(25, pct));
  const layout = $('layout');
  layout.style.setProperty('--top-fr', `${ui.split}fr`);
  layout.style.setProperty('--bottom-fr', `${100 - ui.split}fr`);
}

function initSplitter() {
  const splitter = $('splitter');
  const layout = $('layout');
  let drag = null;
  splitter.addEventListener('pointerdown', (ev) => {
    const live = $('live-panel').getBoundingClientRect();
    const inspector = $('inspector').getBoundingClientRect();
    drag = { top: live.top, total: inspector.bottom - live.top };
    try {
      splitter.setPointerCapture(ev.pointerId);
    } catch {
      // synthetic or already-released pointer: dragging still works while over the handle
    }
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    ev.preventDefault();
  });
  splitter.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    applySplit(((ev.clientY - drag.top) / drag.total) * 100);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    store.set('split', Math.round(ui.split));
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => {
    applySplit(60);
    store.set('split', 60);
  });
  splitter.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 10 : 3;
    if (ev.key === 'ArrowUp') applySplit(ui.split - step);
    else if (ev.key === 'ArrowDown') applySplit(ui.split + step);
    else return;
    ev.preventDefault();
    store.set('split', Math.round(ui.split));
  });
}

// ------------------------------------------------------------------ wiring

const renderers = {
  header: renderHeader,
  stage: renderStage,
  tabs: renderTabs,
  framemeta: renderFrameMeta,
  activity: renderActivity,
  console: renderConsole,
  network: renderNetwork,
  logs: renderLogs,
  sessions: renderSessions,
  agents: renderAgents,
  browsers: renderBrowsers,
};

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function init() {
  applyTheme(ui.theme);
  $('theme-toggle').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length];
    store.set('theme', next);
    applyTheme(next);
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyTheme(ui.theme));

  $('copy-mcp').addEventListener('click', async () => {
    const url = model.server?.mcpUrl;
    if (!url) return;
    const btn = $('copy-mcp');
    const ok = await copyText(url);
    setIcon(btn.querySelector('svg'), ok ? 'check' : 'x');
    btn.classList.toggle('done', ok);
    btn.title = ok ? 'Copied' : 'Copy blocked by the browser: the URL is selected, press Ctrl/Cmd+C';
    if (!ok) window.getSelection()?.selectAllChildren($('mcp-url'));
    setTimeout(() => {
      setIcon(btn.querySelector('svg'), 'copy');
      btn.classList.remove('done');
      btn.title = 'Copy MCP endpoint URL';
    }, 1500);
  });

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  $('btn-shot').addEventListener('click', (ev) => {
    if ($('btn-shot').getAttribute('aria-disabled') === 'true') {
      ev.preventDefault();
      return;
    }
    $('btn-shot').href = `/api/screenshot?browser=${encodeURIComponent(ui.watch)}&t=${Date.now()}`;
  });
  $('browser-select').addEventListener('change', (ev) => switchBrowser(ev.target.value));
  $('agents-rows').addEventListener('click', onAgentsClick);

  // activity filters
  $('activity-tool').addEventListener('change', (ev) => {
    act.filterTool = ev.target.value;
    for (const rec of act.map.values()) if (rec.el) rec.el.hidden = !activityVisible(rec.entry);
    renderActivityChrome();
  });
  $('activity-errors').addEventListener('click', () => {
    act.errorsOnly = !act.errorsOnly;
    $('activity-errors').setAttribute('aria-pressed', String(act.errorsOnly));
    for (const rec of act.map.values()) if (rec.el) rec.el.hidden = !activityVisible(rec.entry);
    renderActivityChrome();
  });

  // inspector tabs (arrow-key navigation per WAI-ARIA tabs pattern)
  const tabButtons = [...document.querySelectorAll('.itab')];
  for (const tab of tabButtons) {
    tab.addEventListener('click', () => selectView(tab.dataset.view));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const i = tabButtons.indexOf(tab);
      const next = tabButtons[(i + (ev.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
      next.focus();
      selectView(next.dataset.view);
    });
  }

  // console
  cons.follow = follower($('console-rows'), $('console-follow'));
  $('console-level').value = cons.level;
  $('console-level').addEventListener('change', (ev) => {
    cons.level = ev.target.value;
    store.set('console.level', cons.level);
    refilterConsole();
  });
  $('console-search').addEventListener(
    'input',
    debounce((ev) => {
      cons.query = ev.target.value.trim().toLowerCase();
      refilterConsole();
    }, 120),
  );
  $('console-clear').addEventListener('click', () => {
    cons.clearedAt = cons.buf.length ? str(cons.buf[cons.buf.length - 1].at) : new Date().toISOString();
    cons.buf.length = 0;
    cons.rebuild = true;
    mark('console');
  });

  // network
  net.follow = follower($('network-scroll'), $('network-follow'));
  $('network-type').addEventListener('change', (ev) => {
    net.type = ev.target.value;
    refilterNetwork();
  });
  $('network-failed').addEventListener('click', () => {
    net.failedOnly = !net.failedOnly;
    $('network-failed').setAttribute('aria-pressed', String(net.failedOnly));
    refilterNetwork();
  });
  $('network-search').addEventListener(
    'input',
    debounce((ev) => {
      net.query = ev.target.value.trim().toLowerCase();
      refilterNetwork();
    }, 120),
  );
  $('network-clear').addEventListener('click', () => {
    let latest = '';
    for (const { entry } of net.map.values()) if (str(entry.startedAt) > latest) latest = str(entry.startedAt);
    net.clearedAt = latest || new Date().toISOString();
    for (const rec of net.map.values()) rec.el?.remove();
    net.map.clear();
    net.dirty.clear();
    mark('network');
  });

  // logs
  logs.follow = follower($('logs-rows'), $('logs-follow'));
  $('logs-level').value = logs.minLevel;
  $('logs-level').addEventListener('change', (ev) => {
    logs.minLevel = ev.target.value;
    store.set('logs.level', logs.minLevel);
    logs.rebuild = true;
    mark('logs');
  });
  $('logs-component').addEventListener('change', (ev) => {
    logs.component = ev.target.value;
    logs.rebuild = true;
    mark('logs');
  });
  $('logs-search').addEventListener(
    'input',
    debounce((ev) => {
      logs.query = ev.target.value.trim().toLowerCase();
      logs.rebuild = true;
      mark('logs');
    }, 150),
  );
  $('logs-rows').addEventListener('click', onLogsClick);

  // keyboard shortcuts
  document.addEventListener('keydown', (ev) => {
    // a held key auto-repeats: each toggle would reconnect the event stream and resend the whole history
    if (ev.defaultPrevented || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))) return;
    if (ev.key === 'p' || ev.key === 'P') {
      togglePause();
      ev.preventDefault();
    } else if (ev.key === 'f' || ev.key === 'F') {
      toggleFullscreen();
      ev.preventDefault();
    }
  });

  applySplit(ui.split);
  initSplitter();
  selectView(ui.view);

  // timers
  setInterval(tickRunning, 250);
  setInterval(() => {
    mark('header', 'framemeta');
    if (conn.state !== 'open') mark('stage');
  }, 1000);
  setInterval(() => mark('sessions'), 5000);
  setInterval(() => {
    if (ui.view === 'agents' && !document.hidden) {
      tickAgents();
      if (Date.now() - model.scriptsLoadedAt > 15_000) void loadScripts();
    }
  }, 1000);

  $('app').dataset.conn = conn.state;
  mark('header', 'stage', 'tabs', 'framemeta', 'activity', 'console', 'network', 'logs', 'sessions', 'agents', 'browsers');
  connect();
}

init();
