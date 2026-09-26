import { EventEmitter } from 'node:events';
import type { LogRecord, LogTap } from '../logger.ts';

/** Id of the shared browser that MCP clients drive directly; sub-agents and scripts get their own. */
export const MAIN_BROWSER = 'main';

export interface ActivityEntry {
  id: string;
  tool: string;
  status: 'queued' | 'running' | 'ok' | 'error';
  args: unknown;
  sessionId: string | null;
  client: string | null;
  tabId: string | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Time spent waiting for earlier tool calls to finish. */
  queuedMs?: number;
  preview?: string;
  error?: string;
  url?: string;
  /** Browser the call acted on (absent: the main browser). */
  browserId?: string;
  /** Sub-agent run that made the call. */
  agentRunId?: string;
}

export interface ConsoleEntry {
  tabId: string;
  level: string;
  text: string;
  url?: string;
  at: string;
  browserId?: string;
}

export interface NetworkEntry {
  tabId: string;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  mimeType: string | null;
  size: number | null;
  initiator: string | null;
  startedAt: string;
  durationMs: number | null;
  state: 'pending' | 'done';
  browserId?: string;
}

export interface FrameData {
  tabId: string;
  url: string;
  title: string;
  at: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  mimeType: 'image/jpeg' | 'image/png';
  data: string;
  browserId?: string;
}

export interface PointerData {
  tabId: string;
  x: number;
  y: number;
  kind: 'click' | 'scroll' | 'type' | 'key';
  label?: string;
  at: string;
  browserId?: string;
}

export interface BrowserEventData {
  event: string;
  reason?: string;
  at: string;
  browserId?: string;
}

/** Dashboard view of one sub-agent run (see src/agents/manager.ts). */
export interface AgentSummary {
  id: string;
  kind: string;
  status: string;
  [key: string]: unknown;
}

export type HubEvent =
  | { type: 'activity'; data: ActivityEntry }
  | { type: 'console'; data: ConsoleEntry }
  | { type: 'network'; data: NetworkEntry }
  | { type: 'log'; data: LogRecord }
  | { type: 'frame'; data: FrameData }
  | { type: 'pointer'; data: PointerData }
  | { type: 'tabs'; data: { browserId?: string; [key: string]: unknown } }
  | { type: 'sessions'; data: unknown }
  | { type: 'status'; data: unknown }
  | { type: 'browser'; data: BrowserEventData }
  | { type: 'agent'; data: AgentSummary }
  | { type: 'browsers'; data: unknown };

type Listener = (event: HubEvent) => void;

/** Event types that belong to one browser and only go to viewers watching it. */
const BROWSER_SCOPED = new Set<HubEvent['type']>(['console', 'network', 'frame', 'pointer', 'tabs', 'browser']);

const browserOf = (data: { browserId?: string }): string => data.browserId ?? MAIN_BROWSER;

class Ring<T> {
  readonly items: T[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
}

/** Console, network and browser-event history of one browser. */
class BrowserHistory {
  readonly console = new Ring<ConsoleEntry>(500);
  readonly network = new Ring<NetworkEntry>(500);
  readonly events = new Ring<BrowserEventData>(50);
}

interface Subscriber {
  live: boolean;
  /** Browser whose console, network, tabs and frames this viewer receives. */
  watch: string;
}

/**
 * Fan-out point between the browser/MCP layers and dashboard viewers.
 * Keeps short histories so a freshly opened dashboard shows recent context,
 * and counts "live" viewers per browser so a screencast only runs while
 * someone watches that browser.
 */
export class Hub extends EventEmitter {
  private readonly subscribers = new Map<Listener, Subscriber>();
  private readonly activity = new Map<string, ActivityEntry>();
  private readonly activityOrder: string[] = [];
  /** Per browser, so a busy sub-agent never pushes the main browser's history out. */
  private readonly histories = new Map<string, BrowserHistory>();
  private readonly agents = new Map<string, AgentSummary>();
  private readonly liveViewers = new Map<string, number>();
  private readonly latestFrames = new Map<string, FrameData>();
  private readonly logTap: LogTap;

  constructor(logTap: LogTap) {
    super();
    this.logTap = logTap;
    this.setMaxListeners(200);
    logTap.on('record', (rec: LogRecord) => this.broadcast({ type: 'log', data: rec }));
  }

  /** Live viewers across all browsers. */
  get viewerCount(): number {
    let n = 0;
    for (const count of this.liveViewers.values()) n += count;
    return n;
  }

  viewerCountFor(browserId: string): number {
    return this.liveViewers.get(browserId) ?? 0;
  }

  /** Latest frame of the main browser (kept for compatibility). */
  get latestFrame(): FrameData | null {
    return this.latestFrames.get(MAIN_BROWSER) ?? null;
  }

  latestFrameFor(browserId: string): FrameData | null {
    return this.latestFrames.get(browserId) ?? null;
  }

  subscribe(listener: Listener, live: boolean, watch: string = MAIN_BROWSER): () => void {
    this.subscribers.set(listener, { live, watch });
    if (live) this.changeViewers(watch, +1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(listener);
      if (live) this.changeViewers(watch, -1);
    };
  }

  private changeViewers(browserId: string, delta: number): void {
    const next = Math.max(0, (this.liveViewers.get(browserId) ?? 0) + delta);
    if (next === 0) this.liveViewers.delete(browserId);
    else this.liveViewers.set(browserId, next);
    this.emit('viewers', next, browserId);
  }

  /** Publishing endpoint for one browser: tags everything it publishes with the browser id. */
  channel(browserId: string): BrowserChannel {
    return new BrowserChannel(this, browserId);
  }

  publishActivity(entry: ActivityEntry): void {
    if (!this.activity.has(entry.id)) {
      this.activityOrder.push(entry.id);
      if (this.activityOrder.length > 500) {
        const removed = this.activityOrder.splice(0, this.activityOrder.length - 500);
        for (const id of removed) this.activity.delete(id);
      }
    }
    this.activity.set(entry.id, entry);
    this.broadcast({ type: 'activity', data: entry });
  }

  private historyOf(browserId: string): BrowserHistory {
    let h = this.histories.get(browserId);
    if (!h) {
      h = new BrowserHistory();
      this.histories.set(browserId, h);
    }
    return h;
  }

  publishConsole(entry: ConsoleEntry): void {
    this.historyOf(browserOf(entry)).console.push(entry);
    this.broadcast({ type: 'console', data: entry });
  }

  publishNetwork(entry: NetworkEntry): void {
    const ring = this.historyOf(browserOf(entry)).network;
    const existing = ring.items.findIndex((n) => n.tabId === entry.tabId && n.requestId === entry.requestId);
    if (existing >= 0) ring.items[existing] = entry;
    else ring.push(entry);
    this.broadcast({ type: 'network', data: entry });
  }

  publishFrame(frame: FrameData): void {
    this.latestFrames.set(browserOf(frame), frame);
    this.broadcast({ type: 'frame', data: frame }, true);
  }

  publishPointer(pointer: PointerData): void {
    this.broadcast({ type: 'pointer', data: pointer });
  }

  publishBrowserEvent(event: string, reason?: string, browserId?: string): void {
    const data: BrowserEventData = { event, reason, at: new Date().toISOString() };
    if (browserId && browserId !== MAIN_BROWSER) data.browserId = browserId;
    this.historyOf(browserOf(data)).events.push(data);
    this.broadcast({ type: 'browser', data });
  }

  publishAgent(summary: AgentSummary): void {
    this.agents.delete(summary.id); // re-insert: most recently updated last
    this.agents.set(summary.id, summary);
    if (this.agents.size > 100) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined) this.agents.delete(oldest);
    }
    this.broadcast({ type: 'agent', data: summary });
  }

  publish(type: 'tabs' | 'sessions' | 'status' | 'browsers', data: unknown): void {
    this.broadcast({ type, data } as HubEvent);
  }

  /** Drop the kept frame and history of a browser that no longer exists and left the browser list. */
  forgetBrowser(browserId: string): void {
    if (browserId === MAIN_BROWSER) return;
    this.latestFrames.delete(browserId);
    this.histories.delete(browserId);
  }

  history(watch: string = MAIN_BROWSER) {
    const h = this.histories.get(watch);
    return {
      activity: this.activityOrder.map((id) => this.activity.get(id)).filter(Boolean),
      console: h ? [...h.console.items] : [],
      network: h ? [...h.network.items] : [],
      logs: this.logTap.buffer.slice(-500),
      browserEvents: h ? [...h.events.items] : [],
      agents: [...this.agents.values()],
    };
  }

  private broadcast(event: HubEvent, liveOnly = false): void {
    const scope = BROWSER_SCOPED.has(event.type) ? browserOf(event.data as { browserId?: string }) : null;
    for (const [listener, meta] of this.subscribers) {
      try {
        if (liveOnly && !meta.live) continue;
        if (scope !== null && scope !== meta.watch) continue;
        listener(event);
      } catch {
        // a broken viewer must never affect the agent
      }
    }
  }
}

/**
 * What one browser (the main one, or a sub-agent's) publishes to the dashboard. Everything is
 * tagged with the browser id, and viewer counts only include viewers watching this browser.
 */
export class BrowserChannel {
  readonly browserId: string;
  readonly hub: Hub;

  constructor(hub: Hub, browserId: string) {
    this.hub = hub;
    this.browserId = browserId;
  }

  private tag<T extends object>(data: T): T {
    return this.browserId === MAIN_BROWSER ? data : { ...data, browserId: this.browserId };
  }

  get viewerCount(): number {
    return this.hub.viewerCountFor(this.browserId);
  }

  /** Called with the new viewer count whenever viewers of this browser come or go. */
  onViewers(fn: (count: number) => void): () => void {
    const listener = (count: number, browserId: string) => {
      if (browserId === this.browserId) fn(count);
    };
    this.hub.on('viewers', listener);
    return () => this.hub.off('viewers', listener);
  }

  publishConsole(entry: ConsoleEntry): void {
    this.hub.publishConsole(this.tag(entry));
  }

  publishNetwork(entry: NetworkEntry): void {
    this.hub.publishNetwork(this.tag(entry));
  }

  publishFrame(frame: FrameData): void {
    this.hub.publishFrame(this.tag(frame));
  }

  publishPointer(pointer: PointerData): void {
    this.hub.publishPointer(this.tag(pointer));
  }

  publishBrowserEvent(event: string, reason?: string): void {
    this.hub.publishBrowserEvent(event, reason, this.browserId);
  }

  publishTabs(data: { tabs: unknown; activeTabId: string | null }): void {
    this.hub.publish('tabs', this.tag(data));
  }

  publishActivity(entry: ActivityEntry): void {
    this.hub.publishActivity(this.tag(entry));
  }
}
