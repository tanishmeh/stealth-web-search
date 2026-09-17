import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import pino from 'pino';
import { loadConfig } from '../../src/config.ts';
import { Hub, type FrameData } from '../../src/dashboard/hub.ts';
import { registerDashboardRoutes } from '../../src/dashboard/routes.ts';
import { LogTap } from '../../src/logger.ts';

interface SseEvent {
  type: string;
  data: any;
}

/** Dashboard routes wired to a real Hub and minimal fakes for the browser/engine/session layers. */
function createDeps() {
  const config = loadConfig({});
  const hub = new Hub(new LogTap());
  const browser = {
    connected: true,
    activeTab: { id: 'tab-1' } as { id: string } | null,
    listTabs: () => (browser.activeTab ? [{ id: browser.activeTab.id, url: 'https://example.com/', title: 'Example', active: true }] : []),
    mutex: { queued: 0 },
    liveView: { enabled: true, frameCount: 0 },
  };
  const deps = {
    config,
    log: pino({ level: 'silent' }),
    hub,
    browser,
    sessions: { list: () => [] },
    obscura: { getStatus: () => ({ mode: 'managed', running: true, ready: true, restarts: 0 }) },
    logFile: '/nonexistent/stealth-browser-mcp.log',
    startedAt: new Date(),
  };
  return { deps, hub, browser };
}

function frame(tabId: string, title: string, bytes = 2000): FrameData {
  return {
    tabId,
    url: 'https://example.com/',
    title,
    at: new Date().toISOString(),
    width: 1280,
    height: 720,
    scrollX: 0,
    scrollY: 0,
    mimeType: 'image/jpeg',
    data: 'A'.repeat(bytes),
  };
}

/**
 * SSE reader on top of node:http so a test can stop reading (res.pause()) and
 * simulate a slow or frozen dashboard tab.
 */
function openStream(port: number, path: string) {
  const events: SseEvent[] = [];
  let buffer = '';
  let ended = false;
  let response: http.IncomingMessage | null = null;
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  const ready = new Promise<void>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } }, (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let idx = buffer.indexOf('\n\n'); idx >= 0; idx = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let type = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) events.push({ type, data: JSON.parse(data.join('\n')) });
        }
        notify();
      });
      const finish = () => {
        ended = true;
        notify();
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
      resolve();
    });
    req.on('error', (err) => {
      ended = true;
      notify();
      reject(err);
    });
  });

  const waitFor = async (label: string, pred: () => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; saw ${events.map((e) => e.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };

  return {
    events,
    ready,
    waitFor,
    get ended() {
      return ended;
    },
    pause: () => response?.pause(),
    resume: () => response?.resume(),
    close: () => response?.destroy(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startRoutes() {
  const ctx = createDeps();
  const app = express();
  registerDashboardRoutes(app, ctx.deps as any);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return { ...ctx, port, close };
}

function bigActivity(i: number, preview: string) {
  return {
    id: `big-${i}`,
    tool: 'browser_markdown',
    status: 'ok' as const,
    args: {},
    sessionId: null,
    client: null,
    tabId: 'tab-1',
    startedAt: new Date().toISOString(),
    preview,
  };
}

describe('dashboard event stream', () => {
  let ctx: Awaited<ReturnType<typeof startRoutes>>;
  let port: number;

  before(async () => {
    ctx = await startRoutes();
    port = ctx.port;
  });
  after(async () => {
    await ctx.close();
  });

  test('hello counts the viewer that is connecting', async () => {
    const stream = openStream(port, '/api/events?live=1');
    try {
      await stream.ready;
      await stream.waitFor('hello', () => stream.events.some((e) => e.type === 'hello'));
      const hello = stream.events.find((e) => e.type === 'hello')!;
      assert.equal(hello.data.liveView.viewers, 1);
      assert.equal(typeof hello.data.server.now, 'string', 'hello carries the server clock for age calculations');
    } finally {
      stream.close();
    }
    await stream.waitFor('stream closed', () => ctx.hub.viewerCount === 0);
  });

  test('a newly connected viewer only gets the latest frame if it belongs to the active tab', async () => {
    ctx.hub.publishFrame(frame('tab-7', 'closed tab'));
    const stale = openStream(port, '/api/events?live=1');
    try {
      await stale.ready;
      await stale.waitFor('hello', () => stale.events.some((e) => e.type === 'hello'));
      await sleep(300);
      assert.equal(stale.events.filter((e) => e.type === 'frame').length, 0, 'no frame of a tab that is gone');
    } finally {
      stale.close();
    }

    ctx.hub.publishFrame(frame('tab-1', 'active tab'));
    const fresh = openStream(port, '/api/events?live=1');
    try {
      await fresh.ready;
      await fresh.waitFor('latest frame', () => fresh.events.some((e) => e.type === 'frame'));
      assert.equal(fresh.events.find((e) => e.type === 'frame')!.data.title, 'active tab');
    } finally {
      fresh.close();
    }
  });

  test('frames are skipped, not buffered, while a viewer is not reading; the latest one still arrives', async () => {
    const stream = openStream(port, '/api/events?live=1');
    try {
      await stream.ready;
      await stream.waitFor('hello', () => stream.events.some((e) => e.type === 'hello'));
      const before = stream.events.filter((e) => e.type === 'frame').length;
      stream.pause();
      const total = 30;
      for (let i = 0; i < total; i++) {
        ctx.hub.publishFrame(frame('tab-1', `frame-${i}`, 1_000_000));
        await sleep(100); // longer than the per-viewer frame interval, so none are coalesced by throttling
      }
      stream.resume();
      await stream.waitFor('latest frame', () => stream.events.some((e) => e.type === 'frame' && e.data.title === `frame-${total - 1}`), 15_000);
      const received = stream.events.filter((e) => e.type === 'frame').length - before;
      assert.ok(received <= 12, `a stalled viewer should not queue every frame (got ${received} of ${total})`);
    } finally {
      stream.close();
    }
  });

  test('periodic status events stay light (no history)', async () => {
    const stream = openStream(port, '/api/events');
    try {
      await stream.ready;
      await stream.waitFor('status', () => stream.events.some((e) => e.type === 'status'), 8_000);
      const status = stream.events.find((e) => e.type === 'status')!;
      for (const key of ['server', 'obscura', 'browser', 'liveView', 'sessions']) assert.ok(key in status.data, key);
      assert.equal('history' in status.data, false);
    } finally {
      stream.close();
    }
  });
});

describe('dashboard event stream memory bounds', () => {
  test('a viewer that stops reading entirely is disconnected instead of growing server memory', async () => {
    const ctx = await startRoutes();
    const stream = openStream(ctx.port, '/api/events');
    try {
      await stream.ready;
      await stream.waitFor('hello', () => stream.events.some((e) => e.type === 'hello'));
      stream.pause();
      const big = 'x'.repeat(1_000_000);
      for (let i = 0; i < 60; i++) ctx.hub.publishActivity(bigActivity(i, big));
      stream.resume();
      await stream.waitFor('server closes the stream', () => stream.ended, 15_000);
      const got = stream.events.filter((e) => e.type === 'activity').length;
      assert.ok(got < 60, `stream should have been cut before all 60 MB were queued (got ${got})`);
    } finally {
      stream.close();
      await ctx.close();
    }
  });

  test('a large initial state is not mistaken for a stalled viewer', async () => {
    const ctx = await startRoutes();
    const big = 'x'.repeat(1_000_000);
    for (let i = 0; i < 40; i++) ctx.hub.publishActivity(bigActivity(i, big));
    const stream = openStream(ctx.port, '/api/events');
    try {
      await stream.ready;
      await stream.waitFor('hello', () => stream.events.some((e) => e.type === 'hello'), 15_000);
      ctx.hub.publishActivity(bigActivity(99, 'small'));
      await stream.waitFor('event after hello', () => stream.events.some((e) => e.type === 'activity' && e.data.id === 'big-99'));
      assert.equal(stream.ended, false);
    } finally {
      stream.close();
      await ctx.close();
    }
  });
});
