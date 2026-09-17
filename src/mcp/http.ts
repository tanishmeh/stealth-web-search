import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { CLIENT_INFO_META_KEY, createMcpHandler, isInitializeRequest, isLegacyRequest, type JSONRPCMessage } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Browser } from '../browser/browser.ts';
import type { Config } from '../config.ts';
import { registerDashboardRoutes } from '../dashboard/routes.ts';
import type { Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { summarize } from '../util/summarize.ts';
import { SERVER_NAME, SERVER_VERSION } from '../version.ts';
import { ALL_TOOLS } from '../tools/index.ts';
import { consumeDispatchedCall, createMcpServer, hiddenResultNote, modernScope, redactArgs, type McpDeps, type ModernScope } from './server.ts';
import { MCP_PATH } from './constants.ts';
import type { SessionRegistry } from './sessions.ts';

export interface HttpDeps extends McpDeps {
  obscura: ObscuraProcess;
  logFile: string;
  startedAt: Date;
}

function tokensMatch(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * The request path with any `token` query parameter redacted, rebuilt from the parsed query so the
 * redaction survives percent-encoded keys (e.g. `tok%65n=`) and matches every occurrence.
 */
function redactedLoggedUrl(req: Request): string {
  const query = req.query as Record<string, unknown>;
  const keys = Object.keys(query);
  if (keys.length === 0) return req.path;
  const parts: string[] = [];
  for (const key of keys) {
    const isToken = key.toLowerCase() === 'token';
    const raw = query[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      const encoded = isToken ? '[REDACTED]' : encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v));
      parts.push(`${encodeURIComponent(key)}=${encoded}`);
    }
  }
  return parts.length ? `${req.path}?${parts.join('&')}` : req.path;
}

/** Decode a cookie value, treating a malformed one as absent instead of throwing. */
function safeDecodeCookie(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function createHttpApp(deps: HttpDeps): express.Express {
  const { config, log, sessions } = deps;
  const httpLog = log.child({ component: 'http' });
  const mcpLog = log.child({ component: 'mcp' });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  const isMcpPath = (p: string) => p.toLowerCase().startsWith(MCP_PATH);

  // ---- access log (every request, with duration and MCP session id)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    const requestId = randomUUID().slice(0, 8);
    // Capture now: on an aborted/oversized request the socket can be gone by 'finish', and
    // dereferencing a null socket there would throw an uncaught exception (crashing the process).
    const remoteAddress = req.socket?.remoteAddress;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const quiet = req.path === '/healthz' || req.path.startsWith('/assets/');
      const loggedPath = redactedLoggedUrl(req);
      const entry = {
        requestId,
        method: req.method,
        path: loggedPath,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        sessionId: req.header('mcp-session-id') ?? undefined,
        remoteAddress: req.socket?.remoteAddress ?? remoteAddress,
        userAgent: req.header('user-agent'),
        contentLength: req.header('content-length') ? Number(req.header('content-length')) : undefined,
      };
      if (quiet) httpLog.debug(entry, `${req.method} ${req.path} ${res.statusCode}`);
      else if (res.statusCode >= 400) httpLog.warn(entry, `${req.method} ${entry.path} ${res.statusCode}`);
      else httpLog.info(entry, `${req.method} ${entry.path} ${res.statusCode}`);
    });
    next();
  });

  // ---- DNS-rebinding protection: only answer for known Host headers
  const hostCheck = hostHeaderValidation(config.allowedHosts);
  app.use((req, res, next) => (req.path === '/healthz' ? next() : hostCheck(req, res, next)));

  // ---- health (unauthenticated, used by Docker HEALTHCHECK)
  app.get('/healthz', async (_req, res) => {
    const status = deps.obscura.getStatus();
    const obscuraUp = await deps.obscura.probe();
    // In managed mode a reachable CDP endpoint is not enough: it could be a foreign/orphaned Obscura
    // answering while our own child is dead. Require the managed child to actually be running.
    const ok = status.mode === 'managed' ? obscuraUp && status.running : obscuraUp;
    const body = {
      ok,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      obscura: { ...status, reachable: obscuraUp },
      browser: { connected: deps.browser.connected, tabs: deps.browser.tabCount },
      sessions: sessions.size,
    };
    res.status(ok ? 200 : 503).json(body);
  });

  // ---- optional bearer-token auth for everything else
  if (config.authToken) {
    const token = config.authToken;
    app.use((req, res, next) => {
      const header = req.header('authorization');
      const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
      if (tokensMatch(token, bearer)) return next();
      // Compare case-insensitively: Express routing is case-insensitive, so /MCP still reaches the MCP
      // handler and must require a bearer token — never the dashboard cookie or ?token=.
      if (!isMcpPath(req.path)) {
        const cookie = /(?:^|;\s*)sbm_token=([^;]+)/.exec(req.header('cookie') ?? '')?.[1];
        if (tokensMatch(token, safeDecodeCookie(cookie))) return next();
        const q = typeof req.query.token === 'string' ? req.query.token : undefined;
        if (tokensMatch(token, q)) {
          res.setHeader('Set-Cookie', `sbm_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
          if (req.method === 'GET' && req.path === '/') return res.redirect(302, '/');
          return next();
        }
      }
      httpLog.warn({ path: req.path, remoteAddress: req.socket?.remoteAddress }, 'rejected request with missing or invalid token');
      if (isMcpPath(req.path)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return jsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid bearer token');
      }
      return res.status(401).type('text/plain').send('Unauthorized. Open the dashboard with ?token=<AUTH_TOKEN>.');
    });
  }

  // ---- MCP endpoint
  const originCheck = originValidation(config.allowedHosts);
  const jsonBody = express.json({ limit: '16mb', type: ['application/json', 'application/*+json'] });

  // The MCP spec requires a JSON body on POST. Reject anything else with 415 *before* the body is
  // read: express.json() only enforces its 16 MB limit for JSON content types, so a huge non-JSON
  // body would otherwise be read whole by toWebRequest and could throw (and orphan the browser).
  const requireJsonBody = (req: Request, res: Response, next: NextFunction) => {
    const ct = (req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct === 'application/json' || (ct.startsWith('application/') && ct.endsWith('+json'))) return next();
    return jsonRpcError(res, 415, -32000, 'Unsupported Media Type: POST /mcp requires a JSON body (Content-Type: application/json).');
  };

  const rawModernHandler = createMcpHandler(() => createMcpServer(deps), {
    legacy: 'reject',
    onerror: (err) => mcpLog.error({ err }, 'MCP (2026-07-28 era) handler error'),
  });
  // Wrap the modern (stateless) handler so its calls are logged and rejected-before-run calls are
  // recorded, mirroring what tapTransport does for 2025-era sessions. JSON responses are tapped in
  // the background (cloned first); streaming responses are left alone (runTool logs their results).
  const modernHandler = toNodeHandler({
    fetch: async (request, options) => {
      const response = await rawModernHandler.fetch(request, options);
      try {
        const scope = modernScope.getStore();
        const ct = response.headers.get('content-type') ?? '';
        if (scope && ct.toLowerCase().includes('application/json')) {
          void tapModernResponse(response.clone(), scope, deps, mcpLog).catch(() => undefined);
        }
      } catch {
        // tapping must never break the response
      }
      return response;
    },
  });

  const handleMcp = async (req: Request, res: Response) => {
    try {
      const parsedBody = req.method === 'POST' ? req.body : undefined;
      const webReq = await toWebRequest(req, parsedBody);
      if (!(await isLegacyRequest(webReq, parsedBody))) {
        const scope: ModernScope = { client: modernClientLabel(parsedBody), dispatched: new Set(), calls: new Map() };
        recordModernInbound(parsedBody, scope, deps, config.log.maxStringLength);
        mcpLog.debug({ method: req.method, client: scope.client, body: summarize(redactRpc(parsedBody, deps), { maxString: config.log.maxStringLength }) }, 'MCP request (modern era)');
        await modernScope.run(scope, () => modernHandler(req, res, parsedBody));
        return;
      }

      const sid = req.header('mcp-session-id');
      if (sid) {
        const existing = sessions.get(sid);
        if (!existing) {
          mcpLog.warn({ sessionId: sid, method: req.method }, 'request for unknown or expired MCP session');
          return jsonRpcError(res, 404, -32001, 'Session not found. Re-initialize the MCP connection.');
        }
        sessions.touch(sid);
        await existing.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
        return jsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID provided (send an initialize request first)');
      }
      await startSession(req, res, parsedBody);
    } catch (err) {
      mcpLog.error({ err }, 'failed to handle MCP request');
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };

  const startSession = async (req: Request, res: Response, body: any) => {
    if (sessions.size >= config.maxSessions) {
      mcpLog.warn({ sessions: sessions.size, max: config.maxSessions }, 'refusing new MCP session: at capacity');
      return jsonRpcError(res, 503, -32000, `Server at capacity: too many concurrent MCP sessions (max ${config.maxSessions}). Close an idle session or try again later.`);
    }
    const clientInfo = body?.params?.clientInfo ?? {};
    const server = createMcpServer(deps);
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.add({
          id,
          clientName: typeof clientInfo.name === 'string' ? clientInfo.name : null,
          clientVersion: typeof clientInfo.version === 'string' ? clientInfo.version : null,
          protocolVersion: typeof body?.params?.protocolVersion === 'string' ? body.params.protocolVersion : null,
          userAgent: req.header('user-agent') ?? null,
          remoteAddress: req.socket.remoteAddress ?? null,
          createdAt: new Date().toISOString(),
          lastSeenAt: Date.now(),
          toolCalls: 0,
          inFlight: 0,
          transport,
          server,
        });
      },
      onsessionclosed: (id: string) => {
        sessions.remove(id, 'client closed the session (HTTP DELETE)');
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.remove(transport.sessionId, 'transport closed');
    };
    await server.connect(transport);
    tapTransport(transport, mcpLog, deps);
    await transport.handleRequest(req, res, body);
  };

  app.post(MCP_PATH, originCheck, requireJsonBody, jsonBody, handleMcp);
  app.get(MCP_PATH, originCheck, handleMcp);
  app.delete(MCP_PATH, originCheck, handleMcp);
  app.all(MCP_PATH, (_req, res) => {
    res.setHeader('Allow', 'GET, POST, DELETE');
    jsonRpcError(res, 405, -32000, 'Method not allowed');
  });

  // ---- dashboard
  if (config.dashboardEnabled) registerDashboardRoutes(app, deps);
  else app.get('/', (_req, res) => res.type('text/plain').send(`${SERVER_NAME} ${SERVER_VERSION}\nMCP endpoint: ${MCP_PATH}\n`));

  app.use((req, res) => {
    res.status(404).json({ error: 'not found', path: req.path });
  });
  app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) httpLog.error({ err, path: req.path }, 'unhandled HTTP error');
    else httpLog.warn({ path: req.path, error: err.message }, 'rejected HTTP request');
    if (res.headersSent) return;
    if (isMcpPath(req.path)) {
      return jsonRpcError(res, status, err.type === 'entity.parse.failed' ? -32700 : -32603, err.type === 'entity.parse.failed' ? 'Parse error' : err.message);
    }
    res.status(status).json({ error: err.message });
  });

  return app;
}

/** Apply tool-argument secret redaction to logged tools/call messages (single or batch). */
function redactRpc(msg: unknown, deps: McpDeps): unknown {
  if (Array.isArray(msg)) return msg.map((m) => redactRpc(m, deps));
  const m = msg as any;
  if (!m || m.method !== 'tools/call' || !m.params?.arguments || typeof m.params.arguments !== 'object') return msg;
  const { args } = redactArgs(String(m.params.name), m.params.arguments, deps.browser, deps.config.log.redactSecrets);
  return args === m.params.arguments ? msg : { ...m, params: { ...m.params, arguments: args } };
}

/** Client label for a stateless (modern) request, taken from its clientInfo or _meta. */
function modernClientLabel(body: unknown): string | null {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs as any[]) {
    if (!m || typeof m !== 'object') continue;
    const ci = m.params?.clientInfo ?? m.params?._meta?.[CLIENT_INFO_META_KEY];
    if (ci && typeof ci === 'object' && typeof ci.name === 'string' && ci.name) {
      return typeof ci.version === 'string' ? `${ci.name} ${ci.version}` : ci.name;
    }
  }
  return null;
}

/** Record the tools/call requests in a modern batch so the response tap can label rejected ones. */
function recordModernInbound(body: unknown, scope: ModernScope, deps: McpDeps, maxString: number): void {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs as any[]) {
    if (!m || m.method !== 'tools/call' || m.id === undefined) continue;
    const redacted = redactRpc(m, deps) as any;
    scope.calls.set(String(m.id), { name: String(m.params?.name ?? ''), args: summarize(redacted.params?.arguments, { maxString }) });
  }
}

/** Log a modern JSON response and record any tools/call the SDK rejected before it reached a handler. */
async function tapModernResponse(response: globalThis.Response, scope: ModernScope, deps: McpDeps, log: Logger): Promise<void> {
  const maxString = deps.config.log.maxStringLength;
  const text = await response.text();
  if (!text) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as any[]) {
    if (!m || m.id === undefined || (m.result === undefined && m.error === undefined)) continue;
    const isError = Boolean(m.error || m.result?.isError);
    log.debug({ dir: 'out', era: 'modern', rpcId: m.id, isError, message: summarize(m, { maxString }) }, `MCP → ${m.error ? 'error' : 'result'} (modern era)`);
    if (!scope.dispatched.has(String(m.id))) {
      const call = scope.calls.get(String(m.id));
      if (call) {
        const joined = (m.result?.content ?? []).map((c: any) => (typeof c.text === 'string' ? c.text : '')).join(' ').trim();
        const message = m.error?.message ?? (joined || 'rejected');
        recordRejectedCall(deps, undefined, call.name, call.args, message, scope.client);
      }
    }
  }
}

/**
 * Tool calls the SDK rejects before a handler runs (invalid arguments, unknown or disabled tool)
 * never reach runTool, so record them here: a warning log line plus a failed activity entry.
 */
function recordRejectedCall(deps: McpDeps, sessionId: string | undefined, name: string, args: unknown, message: string, clientOverride?: string | null): void {
  const now = new Date().toISOString();
  const client = clientOverride ?? deps.sessions.clientLabel(sessionId ?? null);
  deps.log
    .child({ component: 'tool', tool: name, sessionId })
    .warn({ args, client, error: message }, `tool call ${name} rejected before running: ${message}`);
  deps.hub.publishActivity({
    id: randomUUID().slice(0, 8),
    tool: name,
    status: 'error',
    args,
    sessionId: sessionId ?? null,
    client,
    tabId: deps.browser.activeTab?.id ?? null,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    preview: message,
    error: message,
  });
}

/** Log every JSON-RPC message in and out of a session (payloads summarized, secrets redacted). */
function tapTransport(t: NodeStreamableHTTPServerTransport, log: Logger, deps: McpDeps): void {
  const maxString = deps.config.log.maxStringLength;
  const calls = new Map<string, { name: string; args: unknown }>();
  const inbound = t.onmessage;
  t.onmessage = (msg: JSONRPCMessage, extra?: any) => {
    const m = msg as any;
    const redacted = redactRpc(msg, deps) as any;
    if (m?.method === 'tools/call' && m.id !== undefined) {
      calls.set(String(m.id), { name: String(m.params?.name ?? ''), args: summarize(redacted.params?.arguments, { maxString }) });
      if (calls.size > 1000) calls.clear();
    }
    log.debug(
      { dir: 'in', sessionId: t.sessionId, rpcId: m.id, method: m.method, message: summarize(redacted, { maxString }) },
      `MCP ← ${m.method ?? (m.error ? 'error response' : 'response')}`,
    );
    inbound?.(msg, extra);
  };
  const send = t.send.bind(t);
  t.send = async (msg: JSONRPCMessage, opts?: any) => {
    const m = msg as any;
    let logged: unknown = msg;
    const call = m.id !== undefined && (m.result || m.error) ? calls.get(String(m.id)) : undefined;
    if (call) {
      calls.delete(String(m.id));
      const def = ALL_TOOLS.find((tool) => tool.name === call.name);
      if (deps.config.log.redactSecrets && def?.sensitive?.result && m.result && !m.result.isError) {
        logged = { ...m, result: { ...m.result, content: hiddenResultNote(m.result) } };
      }
      if (!consumeDispatchedCall(t.sessionId, m.id)) {
        const message = m.error?.message ?? (m.result?.content ?? []).map((c: any) => c.text ?? '').join(' ').trim() ?? 'rejected';
        recordRejectedCall(deps, t.sessionId, call.name, call.args, message || 'rejected');
      }
    }
    log.debug(
      { dir: 'out', sessionId: t.sessionId, rpcId: m.id, method: m.method, isError: Boolean(m.error || m.result?.isError), message: summarize(logged, { maxString }) },
      `MCP → ${m.method ?? (m.error ? 'error' : 'result')}`,
    );
    return send(msg, opts);
  };
}
