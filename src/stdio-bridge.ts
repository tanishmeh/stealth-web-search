/**
 * stdio <-> Streamable HTTP bridge.
 *
 * Lets MCP clients that can only launch stdio servers (Claude Desktop, older
 * IDE plugins, ...) use the running Stealth Web Search server, so every
 * client shares the same browser, logs and live dashboard:
 *
 *   docker exec -i stealth-web-search node dist/stdio-bridge.js
 *   node dist/stdio-bridge.js http://127.0.0.1:8931/mcp
 *
 * Messages are forwarded verbatim in both directions. The bridge only adds
 * what an HTTP client transport needs: the negotiated protocol version header
 * after `initialize`, a JSON-RPC error for requests that could not be
 * delivered or whose response stream ended without an answer (server crash or
 * restart mid-call), so the stdio client never hangs, and a transparent
 * re-handshake when the server forgot the session (idle timeout, restart).
 * When stdin ends, requests already sent are still answered before the bridge
 * exits, so one-shot pipes (`printf '...' | stdio-bridge`) work.
 *
 * Configuration: first CLI argument or MCP_URL (default
 * http://127.0.0.1:${PORT:-8931}/mcp), AUTH_TOKEN (sent as a bearer token),
 * BRIDGE_LOG_LEVEL (debug|info|warn|error|silent, default info),
 * BRIDGE_CONNECT_TIMEOUT_MS (how long to retry an unreachable server during
 * the handshake, default 15000), BRIDGE_DRAIN_TIMEOUT_MS (how long to wait
 * for in-flight requests after stdin ends, default 330000: longer than a script run or an agent wait).
 *
 * stdout is the JSON-RPC channel: this file must only ever log to stderr.
 */
import {
  SdkHttpError,
  StreamableHTTPClientTransport,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { keepAliveFetch } from './util/keepalive-fetch.ts';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const USAGE = `Usage: stdio-bridge [MCP_URL]

Bridges an MCP client speaking stdio to the Stealth Web Search server's
Streamable HTTP endpoint.

  MCP_URL                    server endpoint (default http://127.0.0.1:8931/mcp)
Environment:
  MCP_URL                    same as the argument (the argument wins)
  AUTH_TOKEN                 bearer token, when the server sets AUTH_TOKEN
  BRIDGE_LOG_LEVEL           debug | info | warn | error | silent (default info; logs go to stderr)
  BRIDGE_CONNECT_TIMEOUT_MS  retry window for an unreachable server during the handshake (default 15000)
  BRIDGE_DRAIN_TIMEOUT_MS    after stdin ends, how long to wait for answers to requests already sent (default 330000)
`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long after the handshake the keep-alive fix is loaded (see src/util/keepalive-fetch.ts). */
const KEEPALIVE_LOAD_DELAY_MS = 500;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseLevel(value: string | undefined): Level {
  const v = (value ?? '').trim().toLowerCase();
  return v in LEVELS ? (v as Level) : 'info';
}

const threshold = LEVELS[parseLevel(process.env.BRIDGE_LOG_LEVEL)];

function log(level: Exclude<Level, 'silent'>, message: string): void {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(`[stealth-web-search-bridge] ${level}: ${message}\n`);
}

function resolveUrl(argv: string[]): URL {
  const arg = argv.find((a) => !a.startsWith('-'));
  const raw = arg ?? process.env.MCP_URL ?? `http://127.0.0.1:${process.env.PORT || '8931'}/mcp`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid MCP URL "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`MCP URL must be http(s), got "${raw}"`);
  return url;
}

/** Network-level failure (server down, DNS, connection reset) as opposed to an HTTP error status. */
function networkErrorCode(err: unknown): string | null {
  if (err instanceof SdkHttpError) return null;
  let e: any = err;
  for (let depth = 0; e && depth < 4; depth++) {
    if (typeof e.code === 'string' && /^E[A-Z]+/.test(e.code)) return e.code;
    e = e.cause;
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'fetch failed';
  return null;
}

function httpStatus(err: unknown): number | null {
  if (err instanceof SdkHttpError) return err.status ?? null;
  const status = (err as any)?.data?.status;
  return typeof status === 'number' ? status : null;
}

function describeError(err: unknown, url: URL): string {
  const code = networkErrorCode(err);
  if (code) {
    return `Cannot reach the Stealth Web Search server at ${url.href} (${code}). Is the server or container running? Set MCP_URL or pass the URL as the first argument.`;
  }
  const status = httpStatus(err);
  if (status === 401) return `The MCP server at ${url.href} requires a token: set AUTH_TOKEN for the bridge to the server's AUTH_TOKEN.`;
  if (status === 403) {
    return `The MCP server at ${url.href} rejected the request (HTTP 403, usually the Host header). Use 127.0.0.1 or add the host name to the server's ALLOWED_HOSTS.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return status ? `MCP server returned HTTP ${status}: ${message}` : message;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE);
    process.exit(0);
  }
  let url: URL;
  try {
    url = resolveUrl(argv);
  } catch (err) {
    process.stderr.write(`[stealth-web-search-bridge] error: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  const connectTimeoutMs = envMs('BRIDGE_CONNECT_TIMEOUT_MS', 15_000);
  // longer than the longest server-side wait (SCRIPT_TIMEOUT_MS 300 s, agent tools 170 s by default)
  const drainTimeoutMs = envMs('BRIDGE_DRAIN_TIMEOUT_MS', 330_000);
  const headers: Record<string, string> = {};
  const token = process.env.AUTH_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  // Only on Node versions whose bundled undici waits a timer tick before each keep-alive reuse, and
  // before the first fetch (a dispatcher installed before it, e.g. a proxy, stays in charge).
  const keepAlive = keepAliveFetch();
  const http = new StreamableHTTPClientTransport(url, { requestInit: { headers }, ...(keepAlive && { fetch: keepAlive.fetch }) });
  const stdio = new StdioServerTransport();

  /** The client's initialize request, replayed when the server lost the session. */
  let initRequest: (JSONRPCMessage & { id: string | number; params?: any }) | null = null;
  /** ids of initialize requests forwarded for the client, to catch their responses. */
  const clientInitIds = new Set<string | number>();
  /** Client requests sent to the server and not answered yet (id -> method). */
  const pending = new Map<string | number, string>();
  /** Responses to requests the bridge sends on its own (re-handshake). */
  const internalWaiters = new Map<string | number, (msg: JSONRPCMessage) => void>();
  /** Held while an initialize exchange is in flight so later messages carry the session id and version. */
  let initGate: Promise<void> | null = null;
  let releaseInitGate: (() => void) | null = null;
  let reinitInFlight: Promise<void> | null = null;
  let reinitCounter = 0;
  let dispatchChain: Promise<void> = Promise.resolve();
  /** stdin ended: no more input, but answers to requests already sent are still written. */
  let draining = false;
  /** Exiting: nothing is forwarded any more. */
  let stopped = false;

  const toClient = async (msg: JSONRPCMessage) => {
    if (stopped) return;
    try {
      await stdio.send(msg);
    } catch (err) {
      log('error', `failed to write to stdout: ${(err as Error).message}`);
    }
  };

  const openInitGate = () => {
    if (initGate) return;
    initGate = new Promise<void>((resolve) => {
      releaseInitGate = resolve;
    });
  };
  const closeInitGate = () => {
    releaseInitGate?.();
    releaseInitGate = null;
    initGate = null;
  };

  http.onmessage = (msg: JSONRPCMessage) => {
    const m = msg as any;
    if (m.id !== undefined && (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg))) {
      const waiter = internalWaiters.get(m.id);
      if (waiter) {
        internalWaiters.delete(m.id);
        waiter(msg);
        return;
      }
      pending.delete(m.id);
      if (clientInitIds.has(m.id)) {
        clientInitIds.delete(m.id);
        if (isJSONRPCResultResponse(msg) && typeof m.result?.protocolVersion === 'string') {
          http.setProtocolVersion(m.result.protocolVersion);
          const info = m.result.serverInfo ?? {};
          log(
            'info',
            `connected to ${info.name ?? 'MCP server'} ${info.version ?? ''} at ${url.href} (protocol ${m.result.protocolVersion}${http.sessionId ? `, session ${http.sessionId}` : ''})`.replace(/\s+\(/, ' ('),
          );
          // after the handshake and the client's first requests, so the import delays neither
          void keepAlive?.load(KEEPALIVE_LOAD_DELAY_MS).then((used) => {
            if (used) log('debug', `keep-alive requests go through undici's Agent (Node's bundled undici ${process.versions.undici} waits a timer tick per request)`);
          });
        } else if (isJSONRPCErrorResponse(msg)) {
          log('warn', `initialize was rejected by the server: ${m.error?.message ?? 'unknown error'}`);
        }
        closeInitGate();
      }
    }
    void toClient(msg);
  };
  // Send failures are reported where they happen; this also sees background
  // SSE stream hiccups, which the transport retries on its own.
  http.onerror = (err: Error) => log('debug', `http transport: ${err.message}`);

  /** Answer a forwarded request with a JSON-RPC error, unless the server already answered it. */
  const failRequest = async (id: string | number, method: string, message: string) => {
    if (!pending.delete(id)) return;
    if (clientInitIds.delete(id)) closeInitGate();
    log('warn', `${method} failed: ${message}`);
    await toClient({ jsonrpc: '2.0', id, error: { code: -32603, message } } as JSONRPCMessage);
  };

  const reportFailure = async (msg: JSONRPCMessage, err: unknown) => {
    const m = msg as any;
    const description = describeError(err, url);
    if (isJSONRPCRequest(msg)) await failRequest(m.id, m.method, description);
    else log('warn', `could not forward ${m.method ?? 'message'}: ${description}`);
  };

  const request = (msg: JSONRPCMessage & { id: string | number }, timeoutMs: number) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        internalWaiters.delete(msg.id);
        reject(new Error(`no response to ${(msg as any).method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        internalWaiters.delete(msg.id);
        fn();
      };
      internalWaiters.set(msg.id, (response) => settle(() => resolve(response)));
      http
        .send(msg, {
          onRequestStreamEnd: () => {
            if (internalWaiters.has(msg.id)) settle(() => reject(new Error(`the server closed the stream before answering ${(msg as any).method}`)));
          },
        })
        .catch((err) => settle(() => reject(err)));
    });

  /** Replay the client's handshake after the server lost the session. */
  const reinitialize = () => {
    if (reinitInFlight) return reinitInFlight;
    reinitInFlight = (async () => {
      if (!initRequest) throw new Error('session expired before the client initialized');
      log('warn', 'the server no longer knows this MCP session (idle timeout or restart); starting a new session');
      const response = await request({ ...initRequest, id: `stealth-web-search-bridge-reinit-${++reinitCounter}` }, 30_000);
      if (response.error) throw new Error(`re-initialize failed: ${response.error.message}`);
      if (typeof response.result?.protocolVersion === 'string') http.setProtocolVersion(response.result.protocolVersion);
      await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
      log('info', `new session ${http.sessionId ?? '(stateless)'} established`);
    })().finally(() => {
      reinitInFlight = null;
    });
    return reinitInFlight;
  };

  const deliver = async (msg: JSONRPCMessage) => {
    const m = msg as any;
    const isInit = isInitializeRequest(msg);
    const isRequest = isJSONRPCRequest(msg);
    if (isRequest) pending.set(m.id, m.method);
    // Streamable HTTP answers a request on its own SSE stream. When that stream
    // ends without the answer (server crashed or restarted mid-call), tell the
    // client instead of leaving the request open forever.
    const options = isRequest
      ? {
          onRequestStreamEnd: () => {
            if (stopped || !pending.has(m.id)) return;
            void failRequest(
              m.id,
              m.method,
              `The MCP server at ${url.href} closed the connection before answering ${m.method} (did the server restart or crash?). Check the server, then retry.`,
            );
          },
        }
      : undefined;
    const deadline = Date.now() + connectTimeoutMs;
    let recoveries = 0;
    for (let attempt = 1; ; attempt++) {
      const sessionAtSend = http.sessionId;
      try {
        await http.send(msg, options);
        return;
      } catch (err) {
        if (stopped) return;
        const status = httpStatus(err);
        if (status === 404 && !isInit && initRequest && recoveries < 2) {
          recoveries++;
          // Another message may already have replaced the session: just resend.
          if (http.sessionId !== sessionAtSend) continue;
          try {
            await reinitialize();
            continue;
          } catch (reinitErr) {
            await reportFailure(msg, reinitErr);
            return;
          }
        }
        if (isInit && networkErrorCode(err) && Date.now() + 500 < deadline) {
          if (attempt === 1) log('info', `waiting for the MCP server at ${url.href} (${networkErrorCode(err)})...`);
          await sleep(Math.min(2_000, 250 * attempt));
          continue;
        }
        await reportFailure(msg, err);
        return;
      }
    }
  };

  const dispatch = async (msg: JSONRPCMessage) => {
    const m = msg as any;
    if (isInitializeRequest(msg)) {
      initRequest = msg as any;
      clientInitIds.add(m.id);
      openInitGate();
      log('debug', `initialize from ${m.params?.clientInfo?.name ?? 'unknown client'} (protocol ${m.params?.protocolVersion ?? '?'})`);
      void deliver(msg);
      return;
    }
    if (initGate) await initGate;
    log('debug', `-> ${m.method ?? `response ${m.id}`}`);
    void deliver(msg);
  };

  stdio.onmessage = (msg: JSONRPCMessage) => {
    // Keep the order in which requests are started; do not wait for their results.
    dispatchChain = dispatchChain.then(() => dispatch(msg)).catch((err) => log('error', `dispatch failed: ${(err as Error).message}`));
  };
  stdio.onerror = (err: Error) => log('warn', `invalid input on stdin: ${err.message}`);

  const shutdown = async (reason: string, code = 0) => {
    if (stopped) return;
    stopped = true;
    log('debug', `shutting down (${reason})`);
    const force = setTimeout(() => process.exit(code), 3_000);
    force.unref();
    if (http.sessionId) {
      await Promise.race([http.terminateSession().catch(() => undefined), sleep(1_500)]);
    }
    await http.close().catch(() => undefined);
    await stdio.close().catch(() => undefined);
    process.exit(code);
  };

  /** stdin ended: answer what was already sent (bounded), then exit. */
  const drainThenShutdown = async (reason: string) => {
    if (draining || stopped) return;
    draining = true;
    const deadline = Date.now() + drainTimeoutMs;
    await Promise.race([dispatchChain, sleep(drainTimeoutMs)]);
    while (pending.size > 0 && !stopped && Date.now() < deadline) await sleep(25);
    if (pending.size > 0 && !stopped) {
      log('warn', `${reason}; giving up on ${pending.size} unanswered request(s) after ${Math.round(drainTimeoutMs / 1000)} s`);
      // the client gets an answer instead of silence
      for (const [id, method] of [...pending]) {
        await failRequest(id, method, `the bridge stopped waiting after ${Math.round(drainTimeoutMs / 1000)} s (BRIDGE_DRAIN_TIMEOUT_MS)`).catch(() => undefined);
      }
    }
    await shutdown(reason);
  };

  // stdio.onclose only fires when the transport gives up (stdout closed, oversized input) or on our own close.
  stdio.onclose = () => void shutdown('stdio closed');
  process.stdin.once('end', () => void drainThenShutdown('stdin ended'));
  process.stdin.once('close', () => void drainThenShutdown('stdin closed'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log('error', `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));

  await http.start();
  await stdio.start();
  log('debug', `bridging stdio to ${url.href}${token ? ' (with bearer token)' : ''}`);
}

main().catch((err) => {
  process.stderr.write(`[stealth-web-search-bridge] fatal: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});
