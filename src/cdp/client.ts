import { EventEmitter } from 'node:events';
import type { Logger } from '../logger.ts';
import { COOKIE_PAYLOAD_KEYS, SECRET_HEADER_KEYS, summarize } from '../util/summarize.ts';

export class CdpError extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`CDP command ${method} did not answer within ${timeoutMs} ms`);
    this.name = 'CdpTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class CdpDisconnectedError extends Error {
  constructor(reason: string) {
    super(`Browser connection lost: ${reason}`);
    this.name = 'CdpDisconnectedError';
  }
}

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

interface Pending {
  method: string;
  quiet: boolean;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export interface SendOptions {
  sessionId?: string;
  timeoutMs?: number;
  /**
   * Log only the method and timing of this command, not its parameters or result
   * (secrets such as typed passwords or storage values, and high-frequency screencast acks).
   */
  quiet?: boolean;
}

/**
 * Obscura's CDP server inspects some raw WebSocket frames by substring before
 * parsing them: any frame containing `"Browser.close"` closes the connection,
 * and frames containing `Fetch.continueRequest|fulfillRequest|failRequest`
 * sent during a navigation are silently dropped. Page text typed by an agent
 * can legitimately contain those tokens, so we escape the dot as a JSON
 * unicode escape (backslash-u-002e) inside the serialized JSON. The JSON value is unchanged after parsing, but
 * the substring no longer matches. We never send those methods ourselves.
 */
export function sanitizeOutgoingFrame(json: string): string {
  return json.replace(/Browser\.close|Fetch\.(?:continueRequest|fulfillRequest|failRequest)/g, (m) =>
    m.replace('.', '\\u002e'),
  );
}

const QUIET_EVENTS = new Set(['Page.screencastFrame']);
const COOKIE_METHOD = /cookie/i;

/**
 * Minimal, dependency-free Chrome DevTools Protocol client over Node's
 * built-in WebSocket, tailored to Obscura's CDP server: flat sessions,
 * per-command timeouts (Obscura can drop replies), structured logging of
 * every command, response and event.
 */
export class CdpConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  readonly url: string;
  private readonly log: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly logEvents: boolean;
  private readonly maxLogString: number;
  private readonly redactSecrets: boolean;

  constructor(url: string, log: Logger, defaultTimeoutMs: number, logEvents: boolean, maxLogString: number, redactSecrets = true) {
    super();
    this.url = url;
    this.log = log;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.logEvents = logEvents;
    this.maxLogString = maxLogString;
    this.redactSecrets = redactSecrets;
    this.setMaxListeners(100);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    this.log.info({ url: this.url }, 'connecting to Obscura CDP endpoint');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out connecting to ${this.url}`));
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${this.url}: ${(ev as ErrorEvent).message ?? 'unknown error'}`));
      });
    });
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', (ev) => this.onClose(`socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`));
    ws.addEventListener('error', (ev) => {
      if (this.closed) return;
      this.log.error({ err: (ev as ErrorEvent).message || 'connection error' }, 'CDP WebSocket error');
    });
    this.log.info({ url: this.url }, 'connected to Obscura CDP endpoint');
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<T> {
    if (!this.ws || !this.isOpen) return Promise.reject(new CdpDisconnectedError('not connected'));
    const id = this.nextId++;
    // setTimeout cannot wait longer than 2^31-1 ms (a larger value fires at once)
    const timeoutMs = Math.min(opts.timeoutMs ?? this.defaultTimeoutMs, 2_147_483_647);
    const message: Record<string, unknown> = { id, method, params };
    if (opts.sessionId) message.sessionId = opts.sessionId;
    const frame = sanitizeOutgoingFrame(JSON.stringify(message));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.log.warn({ id, method, sessionId: opts.sessionId, timeoutMs }, 'CDP command timed out');
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, quiet: Boolean(opts.quiet), resolve, reject, timer, startedAt: performance.now() });
      if (opts.quiet) {
        if (method !== 'Page.screencastFrameAck') this.log.debug({ dir: 'out', id, method, sessionId: opts.sessionId, params: '[not logged]' }, `CDP → ${method}`);
      } else {
        this.log.debug({ dir: 'out', id, method, sessionId: opts.sessionId, params: this.payload(method, params) }, `CDP → ${method}`);
      }
      try {
        this.ws!.send(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpDisconnectedError((err as Error).message));
      }
    });
  }

  /** Summarize a payload for logs, masking cookie values and credential headers unless LOG_REDACT_SECRETS=false. */
  private payload(method: string, value: unknown): unknown {
    const redactKeys = this.redactSecrets ? (COOKIE_METHOD.test(method) ? COOKIE_PAYLOAD_KEYS : SECRET_HEADER_KEYS) : undefined;
    return summarize(value, { maxString: this.maxLogString, redactKeys });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws?.close(1000, 'client closing');
    } catch {
      // ignore
    }
    this.onClose('closed by client');
  }

  private onMessage(data: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'unparseable CDP frame');
      return;
    }

    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.log.debug({ id: msg.id }, 'CDP response for unknown or timed-out command');
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const durationMs = Math.round(performance.now() - p.startedAt);
      if (msg.error) {
        this.log.debug(
          { dir: 'in', id: msg.id, method: p.method, durationMs, error: msg.error },
          `CDP ← ${p.method} failed: ${msg.error.message}`,
        );
        p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      } else {
        if (p.method !== 'Page.screencastFrameAck') {
          this.log.debug(
            { dir: 'in', id: msg.id, method: p.method, durationMs, result: p.quiet ? '[not logged]' : this.payload(p.method, msg.result) },
            `CDP ← ${p.method} (${durationMs} ms)`,
          );
        }
        p.resolve(msg.result ?? {});
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      if (this.logEvents) {
        if (QUIET_EVENTS.has(event.method)) {
          this.log.trace({ dir: 'event', method: event.method, sessionId: event.sessionId }, `CDP event ${event.method}`);
        } else {
          this.log.debug(
            { dir: 'event', method: event.method, sessionId: event.sessionId, params: this.payload(event.method, event.params) },
            `CDP event ${event.method}`,
          );
        }
      }
      this.emit('event', event);
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new CdpDisconnectedError(reason);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    this.log.warn({ reason }, 'CDP connection closed');
    this.emit('disconnected', reason);
  }
}
