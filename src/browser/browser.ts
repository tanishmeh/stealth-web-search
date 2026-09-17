import { EventEmitter } from 'node:events';
import { CdpConnection, type CdpEvent } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import type { Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { ToolError } from './errors.ts';
import { LiveView } from './liveview.ts';
import { Tab } from './tab.ts';

export interface TabSummary {
  id: string;
  url: string;
  title: string;
  active: boolean;
  createdAt: string;
}

/** FIFO async mutex: tool calls run one at a time, in arrival order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private active = 0;

  get queued(): number {
    return this.waiting;
  }

  /** True while a call runs or waits: a new call would have to queue. */
  get busy(): boolean {
    return this.active > 0 || this.waiting > 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await previous;
    this.waiting--;
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      release();
    }
  }
}

/**
 * The single shared browser behind the MCP server. Owns the CDP connection to
 * Obscura, the tab registry and the active tab. All MCP sessions drive this
 * same browser (like one person's browser window), and tool calls are
 * serialized so agents observe consistent, ordered effects.
 *
 * Obscura keeps all page state per CDP connection, so if the connection drops
 * (e.g. Obscura crashed and was restarted) every tab is gone; the next tool
 * call reconnects and the agent is told that state was reset.
 */
export class Browser extends EventEmitter {
  readonly mutex = new Mutex();
  readonly liveView: LiveView;
  private conn: CdpConnection | null = null;
  private connecting: Promise<CdpConnection> | null = null;
  private readonly tabs = new Map<string, Tab>();
  private activeTabId: string | null = null;
  private tabCounter = 0;
  private resetNotice: string | null = null;
  private resetGeneration = 0;
  /** The reset generation each session has already been told about, so every session sees the notice once. */
  private readonly seenResetGen = new Map<string, number>();
  /** A reason for the next connection close (e.g. the engine crashed), used in place of the generic one. */
  private pendingCloseReason: string | null = null;
  private shuttingDown = false;
  private generation = 0;
  private readonly log: Logger;
  private readonly rootLog: Logger;
  private readonly config: Config;
  private readonly obscura: ObscuraProcess;
  private readonly hub: Hub;

  constructor(config: Config, log: Logger, obscura: ObscuraProcess, hub: Hub) {
    super();
    this.config = config;
    this.rootLog = log;
    this.log = log.child({ component: 'browser' });
    this.obscura = obscura;
    this.hub = hub;
    this.liveView = new LiveView(this, hub, config, log);
    obscura.on('exit', (info: { code: number | null; signal: string | null } | undefined) => {
      const why = info?.signal ? `browser engine exited (signal ${info.signal})` : info?.code != null ? `browser engine exited (code ${info.code})` : 'browser engine exited';
      this.pendingCloseReason = why;
      this.conn?.close();
    });
  }

  /** Refuse new work once shutdown starts, so queued/late tool calls don't reconnect mid-shutdown. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  get connected(): boolean {
    return this.conn?.isOpen ?? false;
  }

  get tabCount(): number {
    return this.tabs.size;
  }

  async start(): Promise<void> {
    await this.connection();
  }

  /** Current CDP connection, (re)connecting if needed. */
  async connection(): Promise<CdpConnection> {
    if (this.conn?.isOpen) return this.conn;
    if (this.shuttingDown) throw new ToolError('The server is shutting down; no new browser work is being accepted.');
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (this.obscura.getStatus().mode === 'managed' && !this.obscura.getStatus().ready) {
          await this.obscura.waitReady(30_000);
        }
        const conn = new CdpConnection(
          this.obscura.cdpWebSocketUrl,
          this.rootLog.child({ component: 'cdp' }),
          this.config.browser.cdpCommandTimeoutMs,
          this.config.log.cdpEvents,
          this.config.log.maxStringLength,
          this.config.log.redactSecrets,
        );
        await conn.connect();
        const gen = ++this.generation;
        conn.on('event', (ev: CdpEvent) => this.routeEvent(ev));
        conn.once('disconnected', (reason: string) => this.onDisconnected(gen, reason));
        this.conn = conn;
        this.hub.publishBrowserEvent('connected');
        this.publishTabs();
        return conn;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private onDisconnected(gen: number, reason: string): void {
    if (gen !== this.generation) return;
    // Prefer a specific reason (e.g. the engine crashed with a signal) over the generic socket-close text.
    const why = this.pendingCloseReason ?? reason;
    this.pendingCloseReason = null;
    const hadTabs = this.tabs.size > 0;
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.activeTabId = null;
    this.conn = null;
    if (hadTabs) {
      this.resetGeneration++;
      this.resetNotice = `The browser connection was lost (${why}) and has been re-established; all previously open tabs, pages and cookies were reset.`;
    }
    this.log.warn({ reason: why, hadTabs }, 'browser connection lost; tabs discarded');
    this.hub.publishBrowserEvent('disconnected', why);
    this.liveView.onTabsChanged();
    this.publishTabs();
  }

  /**
   * Notice for the next tool result after a browser reset, delivered once per session: every session
   * that has not yet been told about the latest reset gets it, not only whichever one calls first.
   */
  consumeResetNotice(sessionId: string | null): string | null {
    if (this.resetGeneration === 0 || !this.resetNotice) return null;
    const key = sessionId ?? '__anon__';
    const seen = this.seenResetGen.get(key) ?? 0;
    if (seen >= this.resetGeneration) return null;
    this.seenResetGen.set(key, this.resetGeneration);
    // Keep the map from growing without bound as sessions come and go.
    if (this.seenResetGen.size > 5_000) {
      for (const k of this.seenResetGen.keys()) {
        this.seenResetGen.delete(k);
        if (this.seenResetGen.size <= 2_500) break;
      }
    }
    return this.resetNotice;
  }

  private routeEvent(ev: CdpEvent): void {
    if (ev.sessionId) {
      for (const tab of this.tabs.values()) {
        if (tab.sessionId === ev.sessionId) {
          tab.handleEvent(ev);
          return;
        }
      }
      return;
    }
    if (ev.method === 'Target.targetInfoChanged') {
      const info = ev.params.targetInfo ?? {};
      for (const tab of this.tabs.values()) {
        if (tab.targetId === info.targetId) {
          if (typeof info.url === 'string') tab.url = info.url;
          if (typeof info.title === 'string') tab.title = info.title;
          this.publishTabs();
        }
      }
    }
  }

  // ------------------------------------------------------------------ tabs

  get activeTab(): Tab | null {
    return this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null;
  }

  /** The tab tools operate on; opens one on first use. */
  async ensureActiveTab(): Promise<Tab> {
    if (this.shuttingDown) throw new ToolError('The server is shutting down; no new browser work is being accepted.');
    await this.connection();
    const current = this.activeTab;
    if (current && !current.closed) return current;
    return this.newTab();
  }

  async newTab(): Promise<Tab> {
    const conn = await this.connection();
    let attachedSession: string | undefined;
    const onAttach = (ev: CdpEvent) => {
      if (ev.method === 'Target.attachedToTarget' && typeof ev.params.sessionId === 'string') attachedSession = ev.params.sessionId;
    };
    conn.on('event', onAttach);
    let targetId: string;
    try {
      ({ targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }));
    } finally {
      conn.off('event', onAttach);
    }
    const sessionId = attachedSession ?? `${targetId}-session`;
    const id = `tab-${++this.tabCounter}`;
    const tab = new Tab({ id, targetId, sessionId, conn, log: this.rootLog, hub: this.hub, config: this.config });
    tab.onScreencastFrame = (t, params) => this.liveView.onFrame(t, params);
    tab.onNavigated = () => this.publishTabs();
    this.tabs.set(id, tab);
    try {
      await tab.init();
    } catch (err) {
      this.tabs.delete(id);
      throw err;
    }
    this.activeTabId = id;
    this.log.info({ tabId: id, targetId, sessionId }, 'opened tab');
    this.publishTabs();
    this.liveView.onTabsChanged();
    return tab;
  }

  getTab(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new ToolError(`No such tab: ${id}. Open tabs: ${[...this.tabs.keys()].join(', ') || 'none'}`);
    return tab;
  }

  switchTab(id: string): Tab {
    const tab = this.getTab(id);
    this.activeTabId = id;
    this.log.info({ tabId: id }, 'switched active tab');
    this.publishTabs();
    this.liveView.onTabsChanged();
    return tab;
  }

  async closeTab(id: string): Promise<{ closed: string; active: string | null }> {
    const tab = this.getTab(id);
    try {
      if (this.conn?.isOpen) await this.conn.send('Target.closeTarget', { targetId: tab.targetId });
    } catch (err) {
      this.log.warn({ tabId: id, err: (err as Error).message }, 'Target.closeTarget failed; discarding tab anyway');
    }
    tab.dispose();
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()].sort(compareTabIds);
      this.activeTabId = remaining[remaining.length - 1] ?? null;
    }
    this.log.info({ tabId: id, active: this.activeTabId }, 'closed tab');
    this.publishTabs();
    this.liveView.onTabsChanged();
    return { closed: id, active: this.activeTabId };
  }

  async closeAll(): Promise<number> {
    const ids = [...this.tabs.keys()];
    for (const id of ids) await this.closeTab(id);
    return ids.length;
  }

  listTabs(): TabSummary[] {
    return [...this.tabs.values()]
      .sort((a, b) => compareTabIds(a.id, b.id))
      .map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === this.activeTabId, createdAt: t.createdAt }));
  }

  publishTabs(): void {
    this.hub.publish('tabs', { tabs: this.listTabs(), activeTabId: this.activeTabId });
  }

  async shutdown(): Promise<void> {
    this.liveView.stop();
    this.conn?.close();
  }
}

export function compareTabIds(a: string, b: string): number {
  return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
}
