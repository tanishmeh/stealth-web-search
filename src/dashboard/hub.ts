import { EventEmitter } from 'node:events';
import type { LogRecord, LogTap } from '../logger.ts';

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
}

export interface ConsoleEntry {
  tabId: string;
  level: string;
  text: string;
  url?: string;
  at: string;
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
}

export interface PointerData {
  tabId: string;
  x: number;
  y: number;
  kind: 'click' | 'scroll' | 'type' | 'key';
  label?: string;
  at: string;
}

export type HubEvent =
  | { type: 'activity'; data: ActivityEntry }
  | { type: 'console'; data: ConsoleEntry }
  | { type: 'network'; data: NetworkEntry }
  | { type: 'log'; data: LogRecord }
  | { type: 'frame'; data: FrameData }
  | { type: 'pointer'; data: PointerData }
  | { type: 'tabs'; data: unknown }
  | { type: 'sessions'; data: unknown }
  | { type: 'status'; data: unknown }
  | { type: 'browser'; data: { event: string; reason?: string; at: string } };

type Listener = (event: HubEvent) => void;

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

/**
 * Fan-out point between the browser/MCP layers and dashboard viewers.
 * Keeps short histories so a freshly opened dashboard shows recent context,
 * and counts "live" viewers so the screencast only runs while someone watches.
 */
export class Hub extends EventEmitter {
  private readonly subscribers = new Map<Listener, { live: boolean }>();
  private readonly activity = new Map<string, ActivityEntry>();
  private readonly activityOrder: string[] = [];
  private readonly consoleRing = new Ring<ConsoleEntry>(500);
  private readonly networkRing = new Ring<NetworkEntry>(500);
  private readonly browserEvents = new Ring<{ event: string; reason?: string; at: string }>(50);
  private liveViewers = 0;
  latestFrame: FrameData | null = null;
  private readonly logTap: LogTap;

  constructor(logTap: LogTap) {
    super();
    this.logTap = logTap;
    this.setMaxListeners(50);
    logTap.on('record', (rec: LogRecord) => this.broadcast({ type: 'log', data: rec }));
  }

  get viewerCount(): number {
    return this.liveViewers;
  }

  subscribe(listener: Listener, live: boolean): () => void {
    this.subscribers.set(listener, { live });
    if (live) {
      this.liveViewers++;
      this.emit('viewers', this.liveViewers);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(listener);
      if (live) {
        this.liveViewers = Math.max(0, this.liveViewers - 1);
        this.emit('viewers', this.liveViewers);
      }
    };
  }

  publishActivity(entry: ActivityEntry): void {
    if (!this.activity.has(entry.id)) {
      this.activityOrder.push(entry.id);
      if (this.activityOrder.length > 300) {
        const removed = this.activityOrder.splice(0, this.activityOrder.length - 300);
        for (const id of removed) this.activity.delete(id);
      }
    }
    this.activity.set(entry.id, entry);
    this.broadcast({ type: 'activity', data: entry });
  }

  publishConsole(entry: ConsoleEntry): void {
    this.consoleRing.push(entry);
    this.broadcast({ type: 'console', data: entry });
  }

  publishNetwork(entry: NetworkEntry): void {
    const existing = this.networkRing.items.findIndex((n) => n.tabId === entry.tabId && n.requestId === entry.requestId);
    if (existing >= 0) this.networkRing.items[existing] = entry;
    else this.networkRing.push(entry);
    this.broadcast({ type: 'network', data: entry });
  }

  publishFrame(frame: FrameData): void {
    this.latestFrame = frame;
    this.broadcast({ type: 'frame', data: frame }, true);
  }

  publishPointer(pointer: PointerData): void {
    this.broadcast({ type: 'pointer', data: pointer });
  }

  publishBrowserEvent(event: string, reason?: string): void {
    const data = { event, reason, at: new Date().toISOString() };
    this.browserEvents.push(data);
    this.broadcast({ type: 'browser', data });
  }

  publish(type: 'tabs' | 'sessions' | 'status', data: unknown): void {
    this.broadcast({ type, data } as HubEvent);
  }

  history() {
    return {
      activity: this.activityOrder.map((id) => this.activity.get(id)).filter(Boolean),
      console: this.consoleRing.items,
      network: this.networkRing.items,
      logs: this.logTap.buffer.slice(-500),
      browserEvents: this.browserEvents.items,
    };
  }

  private broadcast(event: HubEvent, liveOnly = false): void {
    for (const [listener, meta] of this.subscribers) {
      try {
        if (liveOnly && !meta.live) continue;
        listener(event);
      } catch {
        // a broken viewer must never affect the agent
      }
    }
  }
}
