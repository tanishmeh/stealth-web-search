import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { MCP_PATH } from '../mcp/constants.ts';
import type { HttpDeps } from '../mcp/http.ts';
import { SERVER_NAME, SERVER_VERSION } from '../version.ts';
import type { FrameData, HubEvent } from './hub.ts';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const FRAME_INTERVAL_MS = 80; // at most ~12 fps per viewer; latest frame always delivered
// A viewer this far behind (slow link, frozen tab) gets no new frames until it catches up; only the newest is kept.
const FRAME_BACKLOG_BYTES = 1024 * 1024;
// A viewer this far behind has stopped reading: close its stream instead of buffering without bound.
// The dashboard reconnects on its own and rehydrates from 'hello'.
const MAX_BACKLOG_BYTES = 32 * 1024 * 1024;

/** Server, engine, browser, live view and session status (no history): sent to every viewer every few seconds. */
export function buildStatus(deps: HttpDeps) {
  const { config, obscura, browser, sessions, hub } = deps;
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
    browser: {
      connected: browser.connected,
      tabs: browser.listTabs(),
      activeTabId: browser.activeTab?.id ?? null,
      queuedCalls: browser.mutex.queued,
      stealth: config.obscura.stealth,
      viewport: config.browser.viewport,
      proxy: config.obscura.proxy ? 'configured' : null,
      allowPrivateNetwork: config.obscura.allowPrivateNetwork,
    },
    liveView: { enabled: browser.liveView.enabled, viewers: hub.viewerCount, frames: browser.liveView.frameCount },
    sessions: sessions.list(),
  };
}

export function buildState(deps: HttpDeps) {
  return { ...buildStatus(deps), history: deps.hub.history() };
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

  app.get('/api/state', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildState(deps));
  });

  app.get('/api/logs/download', (_req, res) => {
    res.download(deps.logFile, 'stealth-browser-mcp.log', (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'log file not available yet' });
    });
  });

  app.get('/api/screenshot', async (_req: Request, res: Response) => {
    const tab = deps.browser.activeTab;
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
    const hello = buildState(deps);
    let held: HubEvent[] | null = [];
    const unsubscribe = deps.hub.subscribe((event: HubEvent) => {
      if (held) held.push(event);
      else onEvent(event);
    }, live);
    hello.liveView.viewers = deps.hub.viewerCount; // include this viewer
    const helloChunk = encode('hello', hello);
    backlogLimit += Buffer.byteLength(helloChunk);
    write(helloChunk);
    // only the active tab's last frame: a frame of a closed tab would show a page that no longer exists
    const latest = deps.hub.latestFrame;
    if (live && latest && latest.tabId === deps.browser.activeTab?.id) {
      send('frame', latest);
      lastFrameSent = Date.now();
    }
    const early = held;
    held = null;
    for (const event of early) onEvent(event);

    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(`: keep-alive ${Date.now()}\n\n`);
    }, 15_000);
    const statusTimer = setInterval(() => send('status', buildStatus(deps)), 5_000);

    log.debug({ live, remoteAddress: req.socket.remoteAddress }, 'dashboard event stream opened');
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
