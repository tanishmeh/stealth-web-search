import type { McpServer } from '@modelcontextprotocol/server';
import type { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';

export interface SessionRecord {
  id: string;
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: number;
  toolCalls: number;
  /** Number of tool calls currently running for this session; a session with any is never reaped. */
  inFlight: number;
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

/** Defensive cap on how many sessions the dashboard/status snapshot serializes at once. */
const MAX_LISTED_SESSIONS = 200;

export interface SessionSummary {
  id: string;
  client: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
  remoteAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  toolCalls: number;
}

/** Tracks sessionful (2025-era Streamable HTTP) MCP clients such as LM Studio. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private reaper: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly hub: Hub;

  constructor(log: Logger, hub: Hub) {
    this.log = log.child({ component: 'mcp-session' });
    this.hub = hub;
  }

  get size(): number {
    return this.sessions.size;
  }

  add(record: SessionRecord): void {
    this.sessions.set(record.id, record);
    this.log.info(
      {
        sessionId: record.id,
        client: record.clientName,
        clientVersion: record.clientVersion,
        protocolVersion: record.protocolVersion,
        userAgent: record.userAgent,
        remoteAddress: record.remoteAddress,
      },
      `MCP session started${record.clientName ? ` by ${record.clientName}` : ''}`,
    );
    this.publish();
  }

  get(id: string | undefined | null): SessionRecord | undefined {
    return id ? this.sessions.get(id) : undefined;
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
  }

  countToolCall(id: string | null): void {
    if (!id) return;
    const s = this.sessions.get(id);
    if (s) s.toolCalls++;
  }

  /** Mark a tool call as started for this session, so the idle reaper won't close it mid-call. */
  beginCall(id: string | null): void {
    if (!id) return;
    const s = this.sessions.get(id);
    if (s) s.inFlight++;
  }

  /** Mark a tool call as finished; also counts as activity so the session's idle timer restarts. */
  endCall(id: string | null): void {
    if (!id) return;
    const s = this.sessions.get(id);
    if (s) {
      s.inFlight = Math.max(0, s.inFlight - 1);
      s.lastSeenAt = Date.now();
    }
  }

  clientLabel(id: string | null): string | null {
    const s = id ? this.sessions.get(id) : undefined;
    if (!s?.clientName) return null;
    return s.clientVersion ? `${s.clientName} ${s.clientVersion}` : s.clientName;
  }

  remove(id: string, reason: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.log.info(
      { sessionId: id, client: s.clientName, reason, toolCalls: s.toolCalls, durationMs: Date.now() - Date.parse(s.createdAt) },
      'MCP session ended',
    );
    this.publish();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].slice(0, MAX_LISTED_SESSIONS).map((s) => ({
      id: s.id,
      client: s.clientName ? `${s.clientName}${s.clientVersion ? ` ${s.clientVersion}` : ''}` : null,
      protocolVersion: s.protocolVersion,
      userAgent: s.userAgent,
      remoteAddress: s.remoteAddress,
      createdAt: s.createdAt,
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      toolCalls: s.toolCalls,
    }));
  }

  /** Close sessions that have been idle longer than `idleMs` (clients often never send DELETE). */
  startReaper(idleMs: number): void {
    if (idleMs <= 0) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const s of [...this.sessions.values()]) {
        // Never reap a session that has a tool call running: closing it would drop the response.
        if (s.inFlight > 0) continue;
        if (now - s.lastSeenAt > idleMs) {
          this.log.info({ sessionId: s.id, idleMs: now - s.lastSeenAt }, 'closing idle MCP session');
          this.remove(s.id, 'idle timeout');
          void s.transport.close().catch(() => undefined);
        }
      }
    }, Math.min(60_000, Math.max(5_000, Math.floor(idleMs / 4))));
    this.reaper.unref();
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const s of [...this.sessions.values()]) {
      this.remove(s.id, 'server shutdown');
      await s.transport.close().catch(() => undefined);
    }
  }

  private publish(): void {
    this.hub.publish('sessions', this.list());
  }
}
