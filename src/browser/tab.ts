import { CdpError, type CdpConnection, type CdpEvent } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import type { ConsoleEntry, Hub, NetworkEntry } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import { truncateString } from '../util/summarize.ts';
import { ElementNotFoundError, JavaScriptError, NavigationError, StaleRefError, ToolError, UnknownRefError } from './errors.ts';
import { DESCRIBE_ELEMENT, IS_LIVE_ELEMENT, PAGE_INFO, QUERY_ONE, SELECTOR_PROBLEM } from './scripts.ts';

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface PageInfo {
  url: string;
  title: string;
  readyState: string;
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  pageHeight: number;
  /** performance.timeOrigin: changes on a real document load, not on history.pushState. */
  timeOrigin: number;
}

export interface RefEntry {
  ref: string;
  nid: number;
  tag: string;
  type: string;
  label: string;
}

export interface ElementHandle {
  objectId: string;
  /** Human readable description for tool output, e.g. `ref e3` or `selector "#email"`. */
  target: string;
  ref?: string;
  nid?: number;
}

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0';

export interface NavigationResult {
  url: string;
  title: string;
  status: number | null;
  durationMs: number;
}

interface EventWaiter {
  predicate: (ev: CdpEvent) => boolean;
  resolve: (ev: CdpEvent | null) => void;
  timer: NodeJS.Timeout;
}

const CONSOLE_CAPACITY = 1000;
const NETWORK_CAPACITY = 500;

/**
 * One browser page (CDP target) plus everything we track about it:
 * console output, network activity, element references and navigation state.
 */
export class Tab {
  readonly id: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly createdAt = new Date().toISOString();
  url = 'about:blank';
  title = '';
  /** Increments on every main-frame navigation event (Obscura also emits one for history.pushState). */
  navSeq = 0;
  closed = false;
  lastFrameAt = 0;
  onScreencastFrame: ((tab: Tab, params: Record<string, any>) => void) | null = null;
  onNavigated: ((tab: Tab) => void) | null = null;

  readonly consoleEntries: ConsoleEntry[] = [];
  private readonly network = new Map<string, NetworkEntry & { startedMs: number }>();
  private readonly lastDocument = new Map<string, number | null>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly nidToRef = new Map<number, string>();
  private refCounter = 0;
  /** Document the current refs belong to (performance.timeOrigin), null when unknown. */
  private refsTimeOrigin: number | null = null;
  /** Page URL when the refs' document was last confirmed (follows history.pushState). */
  private refsUrl = '';
  /** Set when a navigation event arrived; refs are re-validated before they are used. */
  private refsNeedCheck = false;
  private lastTimeOrigin: number | null = null;
  private waiters: EventWaiter[] = [];

  private readonly conn: CdpConnection;
  private readonly log: Logger;
  private readonly consoleLog: Logger;
  private readonly networkLog: Logger;
  private readonly hub: Hub;
  private readonly config: Config;

  constructor(opts: { id: string; targetId: string; sessionId: string; conn: CdpConnection; log: Logger; hub: Hub; config: Config }) {
    this.id = opts.id;
    this.targetId = opts.targetId;
    this.sessionId = opts.sessionId;
    this.conn = opts.conn;
    this.hub = opts.hub;
    this.config = opts.config;
    this.log = opts.log.child({ component: 'browser', tabId: opts.id });
    this.consoleLog = opts.log.child({ component: 'page-console', tabId: opts.id });
    this.networkLog = opts.log.child({ component: 'page-network', tabId: opts.id });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number, quiet = false): Promise<T> {
    if (this.closed) return Promise.reject(new ToolError(`Tab ${this.id} is closed`));
    return this.conn.send<T>(method, params, { sessionId: this.sessionId, timeoutMs, quiet });
  }

  async init(): Promise<void> {
    const { width, height } = this.config.browser.viewport;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  // ---------------------------------------------------------------- events

  handleEvent(ev: CdpEvent): void {
    for (const w of [...this.waiters]) {
      if (w.predicate(ev)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(ev);
      }
    }

    const p = ev.params;
    switch (ev.method) {
      case 'Page.screencastFrame':
        this.lastFrameAt = Date.now();
        this.onScreencastFrame?.(this, p);
        break;
      case 'Page.frameNavigated':
        if (!p.frame?.parentId) {
          this.navSeq++;
          // Obscura reports history.pushState as a full navigation. Element node ids stay valid for
          // same-document changes, so refs are only dropped once pageInfo() sees a new document.
          this.refsNeedCheck = true;
          if (typeof p.frame?.url === 'string') this.url = p.frame.url;
          this.log.info({ url: this.url, navSeq: this.navSeq }, 'page navigated');
          this.onNavigated?.(this);
        }
        break;
      case 'Runtime.consoleAPICalled':
        this.addConsole(mapConsoleLevel(p.type), formatConsoleArgs(p.args ?? []));
        break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
        this.addConsole('exception', `Uncaught ${text}`, d.url);
        break;
      }
      case 'Network.requestWillBeSent':
        this.onRequest(p);
        break;
      case 'Network.responseReceived':
        this.onResponse(p);
        break;
      case 'Network.loadingFinished':
        this.onLoadingFinished(p);
        break;
      default:
        break;
    }
  }

  /** Resolve with the first matching event, or null after `timeoutMs`. */
  waitForEvent(predicate: (ev: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent | null> {
    return new Promise((resolve) => {
      const waiter: EventWaiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  dispose(): void {
    this.closed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiters = [];
  }

  private addConsole(level: string, text: string, url?: string): void {
    const entry: ConsoleEntry = { tabId: this.id, level, text: truncateString(text, 10_000), url, at: new Date().toISOString() };
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > CONSOLE_CAPACITY) this.consoleEntries.splice(0, this.consoleEntries.length - CONSOLE_CAPACITY);
    const logLevel = level === 'error' || level === 'exception' || level === 'assert' ? 'warn' : level === 'warn' ? 'info' : 'debug';
    this.consoleLog[logLevel]({ pageLevel: level, pageUrl: this.url, sourceUrl: url }, `console.${level}: ${truncateString(text, 1000)}`);
    this.hub.publishConsole(entry);
  }

  clearConsole(): void {
    this.consoleEntries.length = 0;
  }

  // ---------------------------------------------------------------- network

  private onRequest(p: Record<string, any>): void {
    const isDocument = p.type === 'Document' && p.requestId === p.loaderId;
    if (isDocument) {
      // a new main document: previous page's requests no longer belong to "this page"
      this.network.clear();
    }
    const entry = {
      tabId: this.id,
      requestId: String(p.requestId),
      method: String(p.request?.method ?? 'GET'),
      url: String(p.request?.url ?? ''),
      resourceType: String(p.type ?? 'Other'),
      status: null,
      mimeType: null,
      size: null,
      initiator: p.initiator?.type ?? null,
      startedAt: p.wallTime ? new Date(p.wallTime * 1000).toISOString() : new Date().toISOString(),
      durationMs: null,
      state: 'pending' as const,
      startedMs: typeof p.timestamp === 'number' ? p.timestamp * 1000 : Date.now(),
    };
    this.network.set(entry.requestId, entry);
    if (this.network.size > NETWORK_CAPACITY) {
      const oldest = this.network.keys().next().value;
      if (oldest !== undefined) this.network.delete(oldest);
    }
    this.hub.publishNetwork(stripInternal(entry));
  }

  private onResponse(p: Record<string, any>): void {
    const entry = this.network.get(String(p.requestId));
    if (!entry) return;
    entry.status = typeof p.response?.status === 'number' ? p.response.status : null;
    entry.mimeType = p.response?.mimeType ?? null;
    if (p.type === 'Document' && p.requestId === p.loaderId) this.lastDocument.set(String(p.loaderId), entry.status);
    this.hub.publishNetwork(stripInternal(entry));
  }

  private onLoadingFinished(p: Record<string, any>): void {
    const entry = this.network.get(String(p.requestId));
    if (!entry) return;
    entry.size = typeof p.encodedDataLength === 'number' ? p.encodedDataLength : null;
    entry.state = 'done';
    // Obscura stamps request, response and completion of document/subresource loads with the same
    // time, so a zero difference means "unknown", not "instant".
    if (typeof p.timestamp === 'number') {
      const ms = Math.round(p.timestamp * 1000 - entry.startedMs);
      entry.durationMs = ms > 0 ? ms : null;
    }
    this.networkLog.debug(
      { method: entry.method, url: entry.url, status: entry.status, type: entry.resourceType, size: entry.size, durationMs: entry.durationMs },
      `${entry.method} ${truncateString(entry.url, 200)} → ${entry.status ?? '?'}`,
    );
    this.hub.publishNetwork(stripInternal(entry));
  }

  networkEntries(): NetworkEntry[] {
    return [...this.network.values()].map(stripInternal);
  }

  // ---------------------------------------------------------------- JavaScript

  /** Evaluate an expression and return the raw RemoteObject (throws JavaScriptError on exceptions). */
  async evaluate(expression: string, opts: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {}): Promise<RemoteObject> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const res = await this.send<{ result: RemoteObject; exceptionDetails?: any }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: opts.returnByValue ?? false,
        awaitPromise: opts.awaitPromise ?? true,
        userGesture: true,
        timeout: timeoutMs,
      },
      timeoutMs + 5_000,
    );
    if (res.exceptionDetails) throw new JavaScriptError(describeException(res.exceptionDetails));
    return res.result;
  }

  /** Call a function declaration in the page (with `this` = objectId when given) and return its JSON value. */
  async callFunction<T = unknown>(
    functionDeclaration: string,
    args: unknown[] = [],
    opts: { objectId?: string; awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number; quiet?: boolean } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const params: Record<string, unknown> = {
      functionDeclaration,
      arguments: args.map((value) => (value === undefined ? {} : { value })),
      returnByValue: opts.returnByValue ?? true,
      awaitPromise: opts.awaitPromise ?? false,
      userGesture: true,
      timeout: timeoutMs,
    };
    if (opts.objectId) params.objectId = opts.objectId;
    let res: { result: RemoteObject; exceptionDetails?: any };
    try {
      res = await this.send<{ result: RemoteObject; exceptionDetails?: any }>('Runtime.callFunctionOn', params, timeoutMs + 5_000, opts.quiet);
    } catch (err) {
      // Obscura reports exceptions thrown inside callFunctionOn as a protocol error ("JS error: …").
      if (err instanceof CdpError && /^JS error:/i.test(err.message)) throw new JavaScriptError(cleanJsError(err.message));
      throw err;
    }
    if (res.exceptionDetails) throw new JavaScriptError(describeException(res.exceptionDetails));
    if (opts.returnByValue === false) return res.result as T;
    return res.result.value as T;
  }

  async pageInfo(): Promise<PageInfo> {
    const info = await this.callFunction<PageInfo>(PAGE_INFO);
    if (info) {
      // A page can navigate itself (link, form, script) to a scheme that would expose local files or
      // run script URLs (file:, javascript:). normalizeUrl only guards tool-argument URLs, so the
      // resulting document is checked here — the one place every navigation and read passes through —
      // and a disallowed one is closed to about:blank before its contents can be returned.
      if (this.isDisallowedDocumentUrl(info.url)) {
        await this.blockDisallowedDocument(info.url);
        throw new NavigationError(
          info.url,
          'that URL scheme is blocked because it could expose local files or run script; the tab was reset to about:blank',
        );
      }
      this.url = info.url;
      this.title = info.title;
      this.lastTimeOrigin = info.timeOrigin;
      // A new document has a new timeOrigin. Obscura v0.2.2 also rebuilds a background tab's JS runtime
      // (new timeOrigin, same DOM and URL, no navigation event) when the tab is used again, so a changed
      // timeOrigin only counts once a navigation event arrived or the URL changed too. In the ambiguous
      // case the old timeOrigin is kept, so a navigation event arriving late still clears the refs.
      const changed = this.refsTimeOrigin !== null && info.timeOrigin !== this.refsTimeOrigin;
      if (changed && (this.refsNeedCheck || info.url !== this.refsUrl)) this.clearRefs();
      if (this.refsTimeOrigin === null) {
        this.refsTimeOrigin = info.timeOrigin;
        this.refsUrl = info.url;
      } else if (!changed) {
        this.refsUrl = info.url;
      }
      this.refsNeedCheck = false;
    }
    return info;
  }

  /** Drop refs if a navigation replaced the document since they were issued. */
  async syncDocument(): Promise<void> {
    if (this.refsNeedCheck) await this.pageInfo();
  }

  /** True when `url`'s scheme is not in the allow-list (file:, javascript:, …); about: and relative URLs are always safe. */
  private isDisallowedDocumentUrl(url: string): boolean {
    const scheme = urlScheme(url);
    if (scheme === '' || scheme === 'about') return false;
    return !this.config.browser.allowedUrlSchemes.includes(scheme);
  }

  /** Reset a page that navigated itself to a blocked scheme back to about:blank so its contents are never read. */
  private async blockDisallowedDocument(badUrl: string): Promise<void> {
    this.log.warn({ url: truncateString(badUrl, 300) }, 'blocked navigation to a disallowed URL scheme; resetting tab to about:blank');
    try {
      await this.send('Page.navigate', { url: 'about:blank', waitUntil: 'load' }, 15_000);
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not reset a blocked document to about:blank');
    }
    this.url = 'about:blank';
    this.title = '';
    this.clearRefs();
    this.refsNeedCheck = false;
  }

  /**
   * Refuse to read a document whose scheme is not allowed. Read tools that do not otherwise call
   * pageInfo() call this first, so a page that navigated itself to file:/javascript: cannot have its
   * contents returned. pageInfo() performs the same check (and the reset) and throws when it fails.
   */
  async guardDocument(): Promise<void> {
    await this.pageInfo();
  }

  // ---------------------------------------------------------------- element refs

  /**
   * Assign refs to element node ids. A node keeps its ref for the lifetime of
   * the document, so the same element is always `eN` between snapshots.
   */
  assignRef(nid: number, tag: string, label: string, type = ''): string {
    if (this.refsNeedCheck) {
      // A navigation happened and nobody re-checked the document: node ids may belong to a new
      // document, so start a fresh ref table rather than risk an old ref pointing at a new element.
      this.clearRefs();
      this.refsNeedCheck = false;
    }
    const existing = this.nidToRef.get(nid);
    if (existing) {
      const entry = this.refs.get(existing)!;
      entry.label = label;
      entry.type = type;
      return existing;
    }
    const ref = `e${++this.refCounter}`;
    this.refs.set(ref, { ref, nid, tag, type, label });
    this.nidToRef.set(nid, ref);
    return ref;
  }

  refForNid(nid: number): string | undefined {
    return this.nidToRef.get(nid);
  }

  refInfo(ref: string): RefEntry | undefined {
    return this.refs.get(ref.trim().replace(/^ref=/, '').replace(/^\[|\]$/g, ''));
  }

  get refCount(): number {
    return this.refs.size;
  }

  clearRefs(): void {
    this.refs.clear();
    this.nidToRef.clear();
    this.refCounter = 0;
    this.refsTimeOrigin = null;
    this.refsUrl = '';
  }

  /** Resolve `{ref}` or `{selector}` to a live element handle. */
  async resolveElement(target: { ref?: string; selector?: string }): Promise<ElementHandle> {
    await this.syncDocument();
    if (target.ref) {
      const ref = target.ref.trim().replace(/^ref=/, '').replace(/^\[|\]$/g, '');
      const entry = this.refs.get(ref);
      if (!entry) throw new UnknownRefError(ref);
      let objectId: string | undefined;
      try {
        const res = await this.send<{ object?: RemoteObject }>('DOM.resolveNode', { backendNodeId: entry.nid });
        objectId = res.object?.objectId;
      } catch (err) {
        if (!(err instanceof CdpError)) throw err;
      }
      if (!objectId) throw new StaleRefError(ref);
      const live = await this.callFunction<boolean>(IS_LIVE_ELEMENT, [], { objectId });
      if (!live) throw new StaleRefError(ref);
      return { objectId, target: `ref ${ref}`, ref, nid: entry.nid };
    }
    if (target.selector) {
      // Obscura leniently matches malformed selectors (e.g. "div[class=quote"), so reject obvious
      // syntax errors before querying rather than clicking whatever it happens to return.
      const syntax = selectorSyntaxError(target.selector);
      if (syntax) throw new ToolError(`Invalid or unsupported CSS selector ${JSON.stringify(target.selector)}: ${syntax}`);
      let obj: RemoteObject;
      try {
        obj = await this.callFunction<RemoteObject>(QUERY_ONE, [target.selector], { returnByValue: false });
      } catch (err) {
        if (err instanceof JavaScriptError) throw new ToolError(`Invalid CSS selector ${JSON.stringify(target.selector)}: ${err.message}`);
        throw err;
      }
      if (!obj.objectId || obj.subtype === 'null') {
        // Obscura returns null instead of throwing for selectors it cannot parse
        const problem = await this.callFunction<string | null>(SELECTOR_PROBLEM, [target.selector]).catch(() => null);
        if (problem) throw new ToolError(`Invalid or unsupported CSS selector ${JSON.stringify(target.selector)}: ${problem}`);
        throw new ElementNotFoundError(`selector ${JSON.stringify(target.selector)}`);
      }
      return { objectId: obj.objectId, target: `selector ${JSON.stringify(target.selector)}` };
    }
    throw new ToolError("Provide either 'ref' (from browser_snapshot) or 'selector' (CSS selector)");
  }

  async describeElement(handle: ElementHandle): Promise<string> {
    try {
      return await this.callFunction<string>(DESCRIBE_ELEMENT, [], { objectId: handle.objectId });
    } catch {
      return handle.target;
    }
  }

  // ---------------------------------------------------------------- navigation

  async navigate(url: string, waitUntil: WaitUntil): Promise<NavigationResult> {
    const started = Date.now();
    let res: { frameId?: string; loaderId?: string };
    try {
      res = await this.send('Page.navigate', { url, waitUntil }, this.config.obscura.navTimeoutMs + 10_000);
    } catch (err) {
      if (err instanceof CdpError) throw new NavigationError(url, cleanNavigationError(err.message));
      throw err;
    }
    // Obscura answers Page.navigate first and then flushes the navigation's events.
    if (res.loaderId && !this.lastDocument.has(res.loaderId)) {
      await this.waitForEvent((ev) => ev.method === 'Page.frameStoppedLoading' || ev.method === 'Page.loadEventFired', 300);
    }
    const status = res.loaderId ? (this.lastDocument.get(res.loaderId) ?? null) : null;
    if (this.lastDocument.size > 50) this.lastDocument.clear();
    const info = await this.pageInfo();
    return { url: info.url, title: info.title, status, durationMs: Date.now() - started };
  }

  /**
   * Run an action that might navigate (click, Enter, submit, evaluate) and
   * report what happened. Obscura completes navigations triggered by input or
   * script inside the triggering command, so a short settle is enough.
   */
  async trackNavigation<T>(action: () => Promise<T>, settleMs = 60): Promise<{ result: T; navigated: boolean; urlChanged: boolean; info: PageInfo }> {
    const beforeSeq = this.navSeq;
    const beforeUrl = this.url;
    const beforeOrigin = this.lastTimeOrigin;
    const result = await action();
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    let info = await this.pageInfo();
    // A new document gets a new timeOrigin; history.pushState keeps it (URL change only). The navigation
    // event can arrive after this settle time, so the URL and timeOrigin decide, not the event alone.
    let navigated: boolean;
    if (beforeOrigin === null) {
      navigated = this.navSeq !== beforeSeq;
    } else if (info.timeOrigin === beforeOrigin) {
      navigated = false;
    } else if (this.navSeq !== beforeSeq || info.url !== beforeUrl) {
      navigated = true;
    } else {
      // new JS realm at the same URL: a reload whose event is still on its way, or a rebuilt background tab
      const ev = await this.waitForEvent((e) => e.method === 'Page.frameNavigated' && !e.params.frame?.parentId, 300);
      navigated = ev !== null || this.navSeq !== beforeSeq;
      if (navigated) info = await this.pageInfo();
    }
    return { result, navigated, urlChanged: navigated || info.url !== beforeUrl, info };
  }
}

// ------------------------------------------------------------------ helpers

/** The lower-cased scheme of a URL (`file`, `https`, `about`, …), or '' when it has none. */
export function urlScheme(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec((url ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * A cheap lexical check for obviously malformed selectors (unbalanced [] / (), an unterminated
 * string). Obscura's querySelector does not throw and will leniently match a selector such as
 * `div[class=quote`, so callers reject these before querying. It returns a reason or null; a
 * lexically valid selector may still be semantically unsupported (caught later by SELECTOR_PROBLEM).
 */
export function selectorSyntaxError(selector: string): string | null {
  let square = 0;
  let paren = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') square++;
    else if (ch === ']') {
      if (--square < 0) return 'unbalanced "]"';
    } else if (ch === '(') paren++;
    else if (ch === ')') {
      if (--paren < 0) return 'unbalanced ")"';
    }
  }
  if (quote) return 'unterminated string';
  if (square > 0) return 'unclosed "["';
  if (paren > 0) return 'unclosed "("';
  return null;
}

function stripInternal(entry: NetworkEntry & { startedMs?: number }): NetworkEntry {
  const { startedMs: _ignored, ...rest } = entry;
  return rest;
}

function mapConsoleLevel(type: string): string {
  switch (type) {
    case 'warning':
      return 'warn';
    case 'assert':
      return 'assert';
    case 'error':
    case 'info':
    case 'debug':
    case 'trace':
      return type;
    default:
      return 'log';
  }
}

function formatConsoleArgs(args: RemoteObject[]): string {
  return args
    .map((a) => {
      if (a.type === 'string') return String(a.value);
      if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
      if (a.unserializableValue) return a.unserializableValue;
      if (a.type === 'undefined') return 'undefined';
      return a.description ?? a.className ?? a.type;
    })
    .join(' ');
}

export function describeException(details: any): string {
  const desc: string | undefined = details?.exception?.description;
  if (desc) {
    // drop Obscura's internal eval wrapper frames
    return desc
      .split('\n')
      .filter((line) => !/<eval-remote>|at eval \(<anonymous>\)$/.test(line))
      .join('\n')
      .trim();
  }
  return details?.text ?? 'Unknown JavaScript error';
}

/** Obscura's "JS error: TypeError: x\n    at __fn (<callFnByValue>…)" → "TypeError: x" (internal frames removed). */
export function cleanJsError(message: string): string {
  const text = message.replace(/^JS error:\s*/i, '');
  if (/execution terminated/i.test(text)) {
    return 'the page script was stopped by the JavaScript watchdog (it ran longer than OBSCURA_JS_WATCHDOG_MS)';
  }
  return text
    .split('\n')
    .filter((line) => !/<callFnByValue>|<eval-remote>|at eval \(<anonymous>\)$/.test(line))
    .join('\n')
    .replace(/^Uncaught\s+/, '')
    .trim();
}

export function cleanNavigationError(message: string): string {
  const m = message.toLowerCase();
  let reason: string | null = null;
  // A host that resolves to a private/internal IP is an SSRF block, not a DNS failure. Its message
  // often also contains "dns error" (the resolution that produced the forbidden address), so this
  // case is tested first, against the full message before the "(source: ...)" tail is stripped.
  if (/ssrf blocked|resolves to forbidden address|private\/internal ip/.test(m))
    reason = 'private/internal addresses are blocked (set ALLOW_PRIVATE_NETWORK=true to allow them)';
  else if (/dns error|failed to lookup address|name or service not known|nodename nor servname|no such host/.test(m)) reason = 'the host name could not be resolved (DNS lookup failed)';
  else if (/connection refused/.test(m)) reason = 'the connection was refused (nothing is listening at that address)';
  else if (/certificate|tls|ssl|handshake/.test(m)) reason = 'a TLS/certificate error occurred';
  else if (/timed out|deadline|timeout/.test(m)) reason = 'the page took too long to load (navigation timeout)';
  else if (/connection reset|broken pipe|connection closed/.test(m)) reason = 'the connection was reset by the server';
  else if (/forbidden url scheme/.test(m)) reason = 'that URL scheme is not supported';
  const cleaned = message.replace(/^(Network error:\s*)+/i, 'Network error: ').replace(/\s*\(source: .*$/s, '').trim();
  return reason ? `${reason}. Details: ${cleaned.slice(0, 300)}` : cleaned.slice(0, 500);
}
