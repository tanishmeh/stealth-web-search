import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { MCP_PATH } from '../mcp/constants.ts';
import type { HttpDeps } from '../mcp/http.ts';
import { SnapshotError, SnapshotNotFoundError, normalizeSnapshotName } from '../snapshots/store.ts';
import { SERVER_NAME, SERVER_VERSION } from '../version.ts';
import { MAIN_BROWSER, type FrameData, type HubEvent } from './hub.ts';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const FRAME_INTERVAL_MS = 80; // at most ~12 fps per viewer; latest frame always delivered
// A viewer this far behind (slow link, frozen tab) gets no new frames until it catches up; only the newest is kept.
const FRAME_BACKLOG_BYTES = 1024 * 1024;
// A viewer this far behind has stopped reading: close its stream instead of buffering without bound.
// The dashboard reconnects on its own and rehydrates from 'hello'.
const MAX_BACKLOG_BYTES = 32 * 1024 * 1024;

/** The browser a viewer asked to watch, if it exists (else the main browser). */
export function resolveWatch(deps: HttpDeps, requested: unknown): string {
  const id = typeof requested === 'string' ? requested.trim() : '';
  if (!id || id === MAIN_BROWSER) return MAIN_BROWSER;
  return deps.registry?.has(id) ? id : MAIN_BROWSER;
}

function watchedBrowserStatus(deps: HttpDeps, watch: string) {
  const { config } = deps;
  const browser = watch === MAIN_BROWSER ? deps.browser : (deps.registry?.browser(watch) ?? null);
  const common = {
    stealth: config.obscura.stealth,
    viewport: config.browser.viewport,
    proxy: config.obscura.proxy ? 'configured' : null,
    allowPrivateNetwork: config.obscura.allowPrivateNetwork,
  };
  if (!browser) return { connected: false, closed: true, tabs: [], activeTabId: null, queuedCalls: 0, ...common };
  return {
    connected: browser.connected,
    tabs: browser.listTabs(),
    activeTabId: browser.activeTab?.id ?? null,
    queuedCalls: browser.mutex.queued,
    ...common,
  };
}

/** Server, engine, browser, live view and session status (no history): sent to every viewer every few seconds. */
export function buildStatus(deps: HttpDeps, watch: string = MAIN_BROWSER) {
  const { config, obscura, browser, sessions, hub } = deps;
  const watched = watch === MAIN_BROWSER ? browser : (deps.registry?.browser(watch) ?? null);
  return {
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      now: new Date().toISOString(), // lets viewers correct ages for clock skew between server and browser
      startedAt: deps.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      mcpUrl: `${config.publicUrl.replace(/\/$/, '')}${MCP_PATH}`,
      authRequired: Boolean(config.authToken),
      logFile: deps.logFile,
      toolsets: config.browser.toolsets,
    },
    obscura: obscura.getStatus(),
    obscuraIsolated: deps.isolatedObscura ? deps.isolatedObscura.getStatus() : null,
    browser: watchedBrowserStatus(deps, watch),
    liveView: { enabled: browser.liveView.enabled, viewers: hub.viewerCount, frames: (watched ?? browser).liveView.frameCount },
    sessions: sessions.list(),
    watching: watch,
    browsers: deps.registry?.list() ?? [{ id: MAIN_BROWSER, label: 'Main browser', kind: 'main', status: 'open', createdAt: deps.startedAt.toISOString() }],
    agents: {
      enabled: config.agent.enabled,
      model: config.agent.model,
      // config/models.json (provider) or the AGENT_LLM_* variables
      config: config.agent.source.type === 'file' ? `${path.basename(config.agent.source.file)} (${config.agent.source.provider})` : 'environment',
      endpoint: config.agent.endpoint ? new URL(config.agent.endpoint).origin : null, // origin only: never credentials
      contextTokens: config.agent.contextTokens,
      running: deps.agents?.activeCount ?? 0,
      // paused on a question for the host (they hold no slot)
      waiting: deps.agents?.waitingCount ?? 0,
      queued: deps.agents?.queuedCount ?? 0,
      maxConcurrent: config.agent.maxConcurrent,
      scriptsDir: config.scripts.dir,
    },
  };
}

export function buildState(deps: HttpDeps, watch: string = MAIN_BROWSER) {
  return { ...buildStatus(deps, watch), history: deps.hub.history(watch) };
}

/**
 * Why a state-changing dashboard request is refused (null: allowed): it must carry X-SBM-Request: 1
 * and an Origin whose host (host:port) is this server's (the Host header, ALLOWED_HOSTS or PUBLIC_URL,
 * so it also works behind a TLS proxy), and Sec-Fetch-Site, when sent, must be same-origin or none.
 */
export function csrfRefusal(req: Request, deps: Pick<HttpDeps, 'config'>): string | null {
  if (req.header('x-sbm-request') !== '1') return 'missing X-SBM-Request header';
  const origin = req.header('origin');
  if (!origin) return 'missing Origin header';
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return 'invalid Origin header';
  }
  let publicHost: string | null = null;
  try {
    publicHost = new URL(deps.config.publicUrl).host.toLowerCase();
  } catch {
    publicHost = null;
  }
  const own = host === (req.header('host') ?? '').toLowerCase() || deps.config.allowedHosts.some((h) => h.toLowerCase() === host) || host === publicHost;
  if (!own) return 'the request comes from another site (Origin)';
  const site = req.header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'the request comes from another site (Sec-Fetch-Site)';
  return null;
}

export function registerDashboardRoutes(app: Express, deps: HttpDeps): void {
  const log = deps.log.child({ component: 'dashboard' });
  if (!existsSync(PUBLIC_DIR)) log.warn({ dir: PUBLIC_DIR }, 'dashboard assets directory not found');

  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile('index.html', { root: PUBLIC_DIR });
  });
  app.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  // browsers request /favicon.ico regardless of <link rel="icon">; avoid a 404 warning per dashboard load
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/assets/favicon.svg'));

  app.get('/api/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildState(deps, resolveWatch(deps, req.query.browser)));
  });

  // Sub-agent run details for the dashboard: progress, each step's reasoning and tool calls, result.
  app.get('/api/agents/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const run = deps.agents?.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: 'no such agent run' });
    // the host's secret answers (one-time codes) never reach the dashboard: masked by value, and not kept in the questions
    res.json(
      run.scrubbed({
        summary: run.summary(),
        input: run.input,
        outcome: run.outcome,
        error: run.error,
        notes: run.notes,
        sources: run.sources,
        script: run.scriptName ? { name: run.scriptName, version: run.scriptVersion, tests: run.tests.map((t) => ({ ...t, output: undefined, ok: t.ok })) } : null,
        questions: run.questionLog(),
        waitedMs: run.waitingMs,
        steps: run.steps.slice(-60).map((st) => ({ ...st, reasoning: st.reasoning.slice(-1_500), content: st.content.slice(0, 1_500) })),
        transcript: run.transcriptFile,
      }),
    );
  });

  app.get('/api/scripts', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ scripts: (await deps.scripts?.store.list()) ?? [] });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Saved sign-ins: metadata only (never cookie names or values), and where each one is loaded.
  app.get('/api/snapshots', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.snapshots) return void res.json({ snapshots: [] });
    try {
      res.json(await deps.snapshots.list());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The dashboard's only mutating route. Registered after the Host check and the AUTH_TOKEN check;
  // a cross-site page cannot call it: the custom header forces a CORS preflight this server never
  // approves, and the Origin must be this server's own.
  app.delete('/api/snapshots/:name', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refusal = csrfRefusal(req, deps);
    if (refusal) {
      log.warn({ path: req.path, reason: refusal, remoteAddress: req.socket?.remoteAddress }, 'refused a dashboard snapshot delete');
      return void res.status(403).json({ error: refusal });
    }
    if (!deps.snapshots) return void res.status(404).json({ error: 'snapshots are not available on this server' });
    let name: string;
    try {
      name = normalizeSnapshotName(String(req.params.name ?? ''));
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    try {
      const { loadedIn } = await deps.snapshots.delete(name, 'dashboard');
      res.json({ deleted: name, loaded_in: loadedIn });
    } catch (err) {
      if (err instanceof SnapshotNotFoundError) return void res.status(404).json({ error: `no snapshot named ${JSON.stringify(name)}` });
      res.status(err instanceof SnapshotError ? 400 : 500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/logs/download', (_req, res) => {
    res.download(deps.logFile, 'stealth-web-search.log', (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'log file not available yet' });
    });
  });

  app.get('/api/screenshot', async (req: Request, res: Response) => {
    const watch = resolveWatch(deps, req.query.browser);
    const tab = (watch === MAIN_BROWSER ? deps.browser : deps.registry?.browser(watch))?.activeTab;
    if (!tab) return res.status(404).json({ error: 'no open tab' });
    try {
      const shot = await tab.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, 30_000);
      res.setHeader('Cache-Control', 'no-store');
      res.type('image/png').send(Buffer.from(shot.data, 'base64'));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/events', (req: Request, res: Response) => {
    const live = req.query.live === '1';
    const watch = resolveWatch(deps, req.query.browser);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    let closed = false;
    let backlogLimit = MAX_BACKLOG_BYTES; // raised by the size of 'hello', which may legitimately be large
    const write = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) return;
      res.write(chunk);
      if (res.writableLength > backlogLimit) {
        log.warn({ live, bufferedBytes: res.writableLength, remoteAddress: req.socket.remoteAddress }, 'dashboard viewer stopped reading; closing its event stream');
        res.destroy();
      }
    };
    const encode = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const send = (type: string, data: unknown) => write(encode(type, data));

    let pendingFrame: FrameData | null = null;
    let lastFrameSent = 0;
    let frameTimer: NodeJS.Timeout | null = null;
    const flushFrame = () => {
      frameTimer = null;
      if (!pendingFrame || closed) return;
      if (res.writableLength > FRAME_BACKLOG_BYTES) {
        frameTimer = setTimeout(flushFrame, FRAME_INTERVAL_MS);
        return;
      }
      const frame = pendingFrame;
      pendingFrame = null;
      send('frame', frame);
      lastFrameSent = Date.now();
    };
    const queueFrame = (frame: FrameData) => {
      pendingFrame = frame;
      if (frameTimer) return;
      const wait = FRAME_INTERVAL_MS - (Date.now() - lastFrameSent);
      if (wait <= 0) flushFrame();
      else frameTimer = setTimeout(flushFrame, wait);
    };
    const onEvent = (event: HubEvent) => {
      if (event.type === 'frame') queueFrame(event.data);
      else send(event.type, event.data);
    };

    // The history is captured before subscribing (so nothing is delivered twice); events raised while
    // subscribing, such as the "viewer connected" log line, are held back until 'hello' is out.
    const hello = buildState(deps, watch);
    let held: HubEvent[] | null = [];
    const unsubscribe = deps.hub.subscribe(
      (event: HubEvent) => {
        if (held) held.push(event);
        else onEvent(event);
      },
      live,
      watch,
    );
    hello.liveView.viewers = deps.hub.viewerCount; // include this viewer
    const helloChunk = encode('hello', hello);
    backlogLimit += Buffer.byteLength(helloChunk);
    write(helloChunk);
    // only the active tab's last frame: a frame of a closed tab would show a page that no longer exists
    // (a finished sub-agent's browser is gone; its last frame shows where it ended)
    const latest = deps.hub.latestFrameFor(watch);
    const watchedBrowser = watch === MAIN_BROWSER ? deps.browser : (deps.registry?.browser(watch) ?? null);
    if (live && latest && (watchedBrowser ? latest.tabId === watchedBrowser.activeTab?.id : watch !== MAIN_BROWSER)) {
      send('frame', latest);
      lastFrameSent = Date.now();
    }
    const early = held;
    held = null;
    for (const event of early) onEvent(event);

    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(`: keep-alive ${Date.now()}\n\n`);
    }, 15_000);
    const statusTimer = setInterval(() => send('status', buildStatus(deps, watch)), 5_000);

    log.debug({ live, watch, remoteAddress: req.socket.remoteAddress }, 'dashboard event stream opened');
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(statusTimer);
      if (frameTimer) clearTimeout(frameTimer);
      pendingFrame = null;
      unsubscribe();
      log.debug({ live }, 'dashboard event stream closed');
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });
}
