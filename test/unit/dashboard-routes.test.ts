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
import { SnapshotNotFoundError } from '../../src/snapshots/store.ts';

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
    logFile: '/nonexistent/stealth-web-search.log',
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

describe('dashboard event stream fan-out', () => {
  /** Raw bytes of one live viewer's stream. */
  function rawStream(port: number) {
    const chunks: Buffer[] = [];
    let response: http.IncomingMessage | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/events?live=1' }, (res) => {
          response = res;
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          resolve();
        })
        .on('error', reject);
    });
    const bytes = () => Buffer.concat(chunks);
    /** Everything after the viewer's own 'hello' event. */
    const afterHello = () => {
      const all = bytes();
      const start = all.indexOf('event: hello\n');
      const end = all.indexOf('\n\n', start);
      return start < 0 || end < 0 ? null : all.subarray(end + 2);
    };
    return { ready, bytes, afterHello, close: () => response?.destroy() };
  }

  test('every viewer gets the same bytes for each event and frame, encoded once per event', async () => {
    const ctx = await startRoutes();
    const viewers = [rawStream(ctx.port), rawStream(ctx.port), rawStream(ctx.port)];
    const stringify = JSON.stringify;
    try {
      await Promise.all(viewers.map((v) => v.ready));
      const deadline = Date.now() + 10_000;
      while (viewers.some((v) => v.afterHello() === null) && Date.now() < deadline) await sleep(20);

      const activity = { ...bigActivity(1, 'Café – 東京 – emoji \u{1F680} – "quotes" \\ back\nslash'), status: 'ok' as const };
      const network = {
        tabId: 'tab-1',
        requestId: 'r1',
        method: 'GET',
        url: 'https://example.com/ü?q=1',
        resourceType: 'Document',
        status: 200,
        mimeType: 'text/html',
        size: 10,
        initiator: null,
        startedAt: new Date().toISOString(),
        durationMs: 3,
        state: 'done' as const,
      };
      const shot = frame('tab-1', 'Überblick 東京 \u{1F680}', 50_000);
      let frameEncodes = 0;
      JSON.stringify = ((value: unknown, ...rest: any[]) => {
        if (value === shot) frameEncodes++;
        return (stringify as any)(value, ...rest);
      }) as typeof JSON.stringify;
      ctx.hub.publishActivity(activity);
      ctx.hub.publishNetwork(network);
      ctx.hub.publishFrame(shot);

      const expected = Buffer.from(
        `event: activity\ndata: ${stringify(activity)}\n\n` + `event: network\ndata: ${stringify(network)}\n\n` + `event: frame\ndata: ${stringify(shot)}\n\n`,
        'utf8',
      );
      while (viewers.some((v) => (v.afterHello()?.length ?? 0) < expected.length) && Date.now() < deadline) await sleep(20);
      for (const [i, v] of viewers.entries()) assert.ok(v.afterHello()!.equals(expected), `viewer ${i} got the same bytes as JSON.stringify gives`);
      assert.equal(frameEncodes, 1, 'the frame is encoded once, not once per viewer');
    } finally {
      JSON.stringify = stringify;
      for (const v of viewers) v.close();
      await ctx.close();
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

describe('dashboard snapshot routes', () => {
  /** Routes with a fake snapshot service that records deletions. */
  async function startSnapshotRoutes(env: Record<string, string> = {}, withService = true) {
    const ctx = createDeps();
    const deleted: Array<[string, string | null]> = [];
    const snapshots = {
      list: async () => ({ snapshots: [{ name: 'shop', loaded_in: ['main'], active_in: ['main'] }], dir: '/data/snapshots', encrypted: true, unencrypted_count: 0 }),
      delete: async (name: string, client: string | null) => {
        if (name === 'missing') throw new SnapshotNotFoundError(`No snapshot named "${name}"`);
        deleted.push([name, client]);
        return { loadedIn: ['main'] };
      },
    };
    const deps = { ...ctx.deps, config: loadConfig(env), snapshots: withService ? snapshots : null };
    const app = express();
    registerDashboardRoutes(app, deps as any);
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const del = (name: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        // node:http, so the test controls Host, Origin and Sec-Fetch-Site exactly as a browser would send them
        const req = http.request({ host: '127.0.0.1', port, method: 'DELETE', path: `/api/snapshots/${name}`, headers }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject);
        req.end();
      });
    const close = async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    };
    return { port, deleted, del, close, own: `http://127.0.0.1:${port}` };
  }

  test('GET lists the snapshots, never cached; without the service the list is empty', async () => {
    const r = await startSnapshotRoutes();
    try {
      const res = await fetch(`http://127.0.0.1:${r.port}/api/snapshots`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.json();
      assert.equal(body.snapshots[0].name, 'shop');
      assert.equal(body.encrypted, true);
    } finally {
      await r.close();
    }
    const none = await startSnapshotRoutes({}, false);
    try {
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${none.port}/api/snapshots`)).json(), { snapshots: [] });
    } finally {
      await none.close();
    }
  });

  test('DELETE is refused without the custom header, without this server\'s Origin, or from another site', async () => {
    const r = await startSnapshotRoutes();
    try {
      const refused: Array<[string, Record<string, string>, RegExp]> = [
        ['no header', { Origin: r.own }, /X-SBM-Request/],
        ['wrong header value', { 'X-SBM-Request': 'yes', Origin: r.own }, /X-SBM-Request/],
        ['no Origin', { 'X-SBM-Request': '1' }, /Origin/],
        ['opaque Origin', { 'X-SBM-Request': '1', Origin: 'null' }, /Origin/],
        ['foreign Origin', { 'X-SBM-Request': '1', Origin: 'https://evil.example' }, /another site/],
        ['same host, other port', { 'X-SBM-Request': '1', Origin: `http://127.0.0.1:${r.port + 1}` }, /another site/],
        ['cross-site fetch', { 'X-SBM-Request': '1', Origin: r.own, 'Sec-Fetch-Site': 'cross-site' }, /Sec-Fetch-Site/],
        ['same-site fetch', { 'X-SBM-Request': '1', Origin: r.own, 'Sec-Fetch-Site': 'same-site' }, /Sec-Fetch-Site/],
      ];
      for (const [label, headers, error] of refused) {
        const res = await r.del('shop', headers);
        assert.equal(res.status, 403, label);
        assert.match(res.body.error, error, label);
      }
      assert.deepEqual(r.deleted, [], 'nothing was deleted');
    } finally {
      await r.close();
    }
  });

  test('DELETE works from this server\'s own pages, ALLOWED_HOSTS and PUBLIC_URL; names are checked and normalized', async () => {
    const r = await startSnapshotRoutes({ ALLOWED_HOSTS: 'dash.internal,pinned.internal:8443', PUBLIC_URL: 'https://mcp.example.com/base' });
    try {
      const ok = await r.del('shop', { 'X-SBM-Request': '1', Origin: r.own, 'Sec-Fetch-Site': 'same-origin' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { deleted: 'shop', loaded_in: ['main'] });
      assert.equal((await r.del('shop', { 'X-SBM-Request': '1', Origin: r.own, 'Sec-Fetch-Site': 'none' })).status, 200, 'typed into the address bar');
      // behind a TLS proxy the Origin is the public host, not the Host header this server sees
      assert.equal((await r.del('shop', { 'X-SBM-Request': '1', Origin: 'https://mcp.example.com' })).status, 200);
      assert.equal((await r.del('shop', { 'X-SBM-Request': '1', Origin: 'https://dash.internal' })).status, 200);
      // a proxy on a non-default port: the Origin carries the port, ALLOWED_HOSTS names the host only
      assert.equal((await r.del('shop', { 'X-SBM-Request': '1', Origin: 'https://dash.internal:9443', 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'an ALLOWED_HOSTS name matches on any port');
      assert.equal((await r.del('shop', { 'X-SBM-Request': '1', Origin: 'https://pinned.internal:8443' })).status, 200, 'an entry with a port matches that port');
      const refused: Array<[string, Record<string, string>]> = [
        ['an entry with a port matches no other port', { 'X-SBM-Request': '1', Origin: 'https://pinned.internal:9443' }],
        ['PUBLIC_URL keeps its port', { 'X-SBM-Request': '1', Origin: 'https://mcp.example.com:8443' }],
        ['a subdomain of an allowed name is another site', { 'X-SBM-Request': '1', Origin: 'https://evil.dash.internal' }],
        ['loopback names stay exact: another port is another local server', { 'X-SBM-Request': '1', Origin: `http://localhost:${r.port + 1}` }],
        ['any port, still not from another site', { 'X-SBM-Request': '1', Origin: 'https://dash.internal:9443', 'Sec-Fetch-Site': 'same-site' }],
      ];
      for (const [label, headers] of refused) assert.equal((await r.del('shop', headers)).status, 403, label);
      const own = { 'X-SBM-Request': '1', Origin: r.own };
      assert.equal((await r.del('My%20Shop', own)).status, 200);
      for (const bad of ['%2e%2e', '%2f', 'a%2fb', '%00', '-x', 'x'.repeat(65)]) {
        const res = await r.del(bad, own);
        assert.equal(res.status, 400, bad);
        assert.match(res.body.error, /Invalid snapshot name/, bad);
      }
      assert.equal((await r.del('missing', own)).status, 404);
      assert.deepEqual(
        r.deleted.map(([name]) => name),
        ['shop', 'shop', 'shop', 'shop', 'shop', 'shop', 'my-shop'],
      );
      assert.ok(r.deleted.every(([, client]) => client === 'dashboard'), 'logged as the dashboard');
    } finally {
      await r.close();
    }
    const none = await startSnapshotRoutes({}, false);
    try {
      assert.equal((await none.del('shop', { 'X-SBM-Request': '1', Origin: none.own })).status, 404);
    } finally {
      await none.close();
    }
  });
});
