import { EventEmitter } from 'node:events';
import { CdpConnection, type CdpEvent } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import { MAIN_BROWSER, type BrowserChannel, type Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { ToolError } from './errors.ts';
import { LiveView } from './liveview.ts';
import type { StorageItem } from './storage-state.ts';
import { Tab } from './tab.ts';

export interface TabSummary {
  id: string;
  url: string;
  title: string;
  active: boolean;
  createdAt: string;
}

/** A snapshot (saved sign-in) loaded into a browser: the version loaded, and the connection it went into. */
export interface LoadedSnapshot {
  version: number;
  loadedAt: string;
  generation: number;
}

/** Site storage a loaded snapshot restores on every page load of one origin. */
export interface SeedEntry {
  snapshot: string;
  localStorage: StorageItem[];
  sessionStorage: StorageItem[];
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
 * A browser behind the MCP server. Owns one CDP connection to Obscura, the tab
 * registry and the active tab. The main browser (id "main") is shared by all
 * MCP sessions (like one person's browser window), and tool calls are
 * serialized so agents observe consistent, ordered effects. Sub-agents and
 * scripts get browsers of their own: Obscura isolates pages and cookies per
 * CDP connection, so they never disturb the main browser or each other.
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
  /** Why the connection was last lost (for the notice written after a reconnect). */
  private lostReason: string | null = null;
  /**
   * Snapshots loaded into this browser, by name (SnapshotService sets them). Cookies and site storage
   * live on the connection, so they are all cleared when it is lost.
   */
  readonly loadedSnapshots = new Map<string, LoadedSnapshot>();
  /** The snapshot loaded, created or refreshed here most recently. */
  activeSnapshot: string | null = null;
  /** Site storage of loaded snapshots by origin, written on every page load by one new-document script. */
  readonly storageSeed = new Map<string, SeedEntry>();
  /** That script's identifier and the connection generation that issued it (identifiers restart on every connection). */
  seedScript: { id: string; generation: number } | null = null;
  /**
   * Runs after a lost connection is re-established, before the new connection is used: an agent
   * browser re-applies the snapshot its run started with. Resolves to the notice for the agent.
   */
  reconnectHook: ((conn: CdpConnection, generation: number) => Promise<string>) | null = null;
  private readonly log: Logger;
  private readonly rootLog: Logger;
  private readonly config: Config;
  private readonly obscura: ObscuraProcess;
  private readonly hub: BrowserChannel;
  private readonly onEngineExit: (info: { code: number | null; signal: string | null } | undefined) => void;
  /** "main", or the id of a sub-agent's / script's own browser. */
  readonly id: string;

  constructor(config: Config, log: Logger, obscura: ObscuraProcess, hub: Hub, opts: { id?: string } = {}) {
    super();
    this.id = opts.id ?? MAIN_BROWSER;
    this.config = config;
    this.rootLog = this.id === MAIN_BROWSER ? log : log.child({ browserId: this.id });
    this.log = this.rootLog.child({ component: 'browser' });
    this.obscura = obscura;
    this.hub = hub.channel(this.id);
    this.liveView = new LiveView(this, this.hub, config, this.rootLog);
    this.onEngineExit = (info) => {
      const why = info?.signal ? `browser engine exited (signal ${info.signal})` : info?.code != null ? `browser engine exited (code ${info.code})` : 'browser engine exited';
      this.pendingCloseReason = why;
      this.conn?.close();
    };
    obscura.on('exit', this.onEngineExit);
  }

  /** Dashboard channel of this browser (tags events with its id). */
  get channel(): BrowserChannel {
    return this.hub;
  }

  /** Refuse new work once shutdown starts, so queued/late tool calls don't reconnect mid-shutdown. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  get connected(): boolean {
    return this.conn?.isOpen ?? false;
  }

  /** How many times the connection was lost with open tabs or loaded snapshots (their pages and cookies are gone). */
  get resetCount(): number {
    return this.resetGeneration;
  }

  get tabCount(): number {
    return this.tabs.size;
  }

  /** Changes with every new connection (and on dispose): state set on an older generation is gone. */
  get connectionGeneration(): number {
    return this.generation;
  }

  /** Record that a snapshot is loaded here (load, create, refresh) and make it the active one. */
  markSnapshot(name: string, version: number, generation: number): void {
    this.loadedSnapshots.set(name, { version, loadedAt: new Date().toISOString(), generation });
    this.activeSnapshot = name;
    this.emit('snapshots');
  }

  /** Forget a snapshot (it was deleted): its markers and its storage-seed entries. True when the seed changed. */
  forgetSnapshot(name: string): boolean {
    let changed = this.loadedSnapshots.delete(name);
    if (this.activeSnapshot === name) {
      this.activeSnapshot = null;
      changed = true;
    }
    let seedChanged = false;
    for (const [origin, entry] of this.storageSeed) {
      if (entry.snapshot === name) {
        this.storageSeed.delete(origin);
        seedChanged = true;
      }
    }
    if (changed || seedChanged) this.emit('snapshots');
    return seedChanged;
  }

  /** Drop every snapshot marker and the storage seed (the connection that held them is gone). Returns the names that were loaded. */
  private clearSnapshots(): string[] {
    const names = [...this.loadedSnapshots.keys()];
    const had = names.length > 0 || this.activeSnapshot !== null || this.storageSeed.size > 0 || this.seedScript !== null;
    this.loadedSnapshots.clear();
    this.activeSnapshot = null;
    this.storageSeed.clear();
    this.seedScript = null;
    if (had) this.emit('snapshots');
    return names;
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
        if (this.shuttingDown) {
          // disposed while connecting: do not keep a connection nobody will close
          conn.close();
          throw new ToolError('This browser has been closed.');
        }
        const gen = ++this.generation;
        conn.on('event', (ev: CdpEvent) => this.routeEvent(ev));
        conn.once('disconnected', (reason: string) => this.onDisconnected(gen, reason));
        if (this.reconnectHook && gen > 1) {
          // before anyone uses the new connection, so the first new tab already has the sign-in
          const line = await this.reconnectHook(conn, gen).catch(() => null);
          if (line) this.resetNotice = `The browser connection was lost (${this.lostReason ?? 'connection closed'}). ${line}`;
          if (this.shuttingDown) {
            conn.close();
            throw new ToolError('This browser has been closed.');
          }
        }
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
    const hadSeed = this.storageSeed.size > 0 || this.seedScript !== null;
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.activeTabId = null;
    this.conn = null;
    this.lostReason = why;
    // snapshots applied before any tab was opened are lost too: always tell the agent about them
    const lost = this.clearSnapshots();
    if (hadTabs || lost.length || hadSeed) {
      this.resetGeneration++;
      this.resetNotice = hadTabs
        ? `The browser connection was lost (${why}) and has been re-established; all previously open tabs, pages and cookies were reset.`
        : `The browser connection was lost (${why}) and has been re-established; its cookies were reset.`;
      // an agent browser with a reconnect hook gets its notice when the hook re-applies its sign-in
      if (lost.length && !this.reconnectHook) this.resetNotice += ` ${this.lostSnapshotsLine(lost)}`;
    }
    this.log.warn({ reason: why, hadTabs, lostSnapshots: lost.length || undefined }, 'browser connection lost; tabs discarded');
    this.hub.publishBrowserEvent('disconnected', why);
    this.liveView.onTabsChanged();
    this.publishTabs();
  }

  /** What the agent is told about the snapshots a reset took away (sub-agents have no snapshot_load). */
  private lostSnapshotsLine(names: string[]): string {
    const quoted = names.map((n) => JSON.stringify(n)).join(', ');
    if (this.id !== MAIN_BROWSER) return `The browser was reset; your saved sign-in ${quoted} was lost; sign in again or finish with success=false.`;
    return names.length === 1
      ? `The snapshot ${quoted} loaded in this browser was lost; load it again with snapshot_load.`
      : `The snapshots ${quoted} loaded in this browser were lost; load them again with snapshot_load.`;
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
    this.hub.publishTabs({ tabs: this.listTabs(), activeTabId: this.activeTabId });
  }

  async shutdown(): Promise<void> {
    this.liveView.stop();
    this.conn?.close();
  }

  /**
   * Close a sub-agent's or script's browser for good: its pages, cookies and storage are discarded
   * (Obscura keeps them per connection) and it stops listening for engine restarts.
   */
  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.obscura.off('exit', this.onEngineExit);
    this.liveView.stop();
    const conn = this.conn;
    this.generation++; // the close below must not be reported as a lost connection
    this.reconnectHook = null;
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    this.activeTabId = null;
    this.conn = null;
    this.clearSnapshots();
    conn?.close();
    this.hub.publishBrowserEvent('closed');
    this.publishTabs();
  }
}

export function compareTabIds(a: string, b: string): number {
  return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
}
