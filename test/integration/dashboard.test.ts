import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';
import { signIn } from '../helpers/sign-in.ts';

interface SseEvent {
  type: string;
  data: any;
}

const authHeaders = (): Record<string, string> => (process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {});

/** Minimal Server-Sent Events client on top of fetch, for asserting the dashboard stream. */
function openEventStream(url: string) {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const waiters: Array<{ pred: (ev: SseEvent) => boolean; resolve: (ev: SseEvent) => void; timer: NodeJS.Timeout }> = [];
  const pump = (async () => {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream', ...authHeaders() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let idx = buffer.indexOf('\n\n'); idx >= 0; idx = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let type = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7);
          else if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (!data.length) continue; // keep-alive comment
        const ev = { type, data: JSON.parse(data.join('\n')) };
        events.push(ev);
        for (const w of [...waiters]) {
          if (w.pred(ev)) {
            clearTimeout(w.timer);
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(ev);
          }
        }
      }
    }
  })().catch((err) => {
    if ((err as Error).name !== 'AbortError') throw err;
  });

  const waitFor = (label: string, pred: (ev: SseEvent) => boolean, timeoutMs = 20_000): Promise<SseEvent> => {
    const existing = events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${label}; saw: ${events.map((e) => e.type).join(', ')}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  };

  const close = async () => {
    controller.abort();
    await pump;
  };
  return { events, waitFor, close };
}

async function getState(baseUrl: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/state`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  return res.json();
}

async function eventually<T>(label: string, fn: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The live dashboard: static shell, state endpoint and the SSE contract its UI relies on. */
describe('dashboard', () => {
  let fx: FixtureServer;
  let srv: TestServer;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  test('serves the app shell and its static assets', async () => {
    const page = await fetch(`${srv.baseUrl}/`, { headers: authHeaders() });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Stealth Web Search<\/title>/);
    for (const asset of ['/assets/app.js', '/assets/styles.css', '/assets/theme.js', '/assets/favicon.svg']) {
      assert.ok(html.includes(asset), `index.html references ${asset}`);
    }
    // no third-party resources: the dashboard must work offline and leak nothing
    assert.doesNotMatch(html, /(src|href)="https?:\/\//);

    const expectations: Array<[string, RegExp]> = [
      ['/assets/app.js', /javascript/],
      ['/assets/lib.js', /javascript/],
      ['/assets/theme.js', /javascript/],
      ['/assets/styles.css', /text\/css/],
      ['/assets/favicon.svg', /image\/svg\+xml/],
    ];
    for (const [path, type] of expectations) {
      const res = await fetch(`${srv.baseUrl}${path}`, { headers: authHeaders() });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', type, path);
      assert.ok((await res.text()).length > 100, `${path} has content`);
    }

    const favicon = await fetch(`${srv.baseUrl}/favicon.ico`, { redirect: 'manual', headers: authHeaders() });
    assert.equal(favicon.status, 301);
    assert.equal(favicon.headers.get('location'), '/assets/favicon.svg');
  });

  test('dashboard scripts never build HTML from strings', () => {
    for (const file of ['app.js', 'lib.js', 'theme.js']) {
      const source = readFileSync(new URL(`../../src/dashboard/public/${file}`, import.meta.url), 'utf8');
      const code = source.replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function/, file);
      assert.ok(!source.includes(String.fromCharCode(0)), `${file} contains no raw NUL bytes`);
    }
  });

  test('state endpoint describes server, engine, browser, live view and history', async () => {
    const state = await getState(srv.baseUrl);
    assert.equal(state.server.name, 'stealth-web-search');
    assert.match(state.server.mcpUrl, /\/mcp$/);
    assert.equal(typeof state.server.uptimeSec, 'number');
    assert.equal(state.obscura.ready, true);
    assert.equal(typeof state.browser.connected, 'boolean');
    assert.ok(Array.isArray(state.browser.tabs));
    assert.equal(typeof state.liveView.viewers, 'number');
    assert.ok(Array.isArray(state.sessions));
    for (const key of ['activity', 'console', 'network', 'logs', 'browserEvents']) assert.ok(Array.isArray(state.history[key]), key);
  });

  test('live stream carries activity, tabs, frames, pointer markers and network', async () => {
    const before = await getState(srv.baseUrl);
    const stream = openEventStream(`${srv.baseUrl}/api/events?live=1`);
    try {
      const hello = await stream.waitFor('hello', (e) => e.type === 'hello');
      assert.ok(hello.data.server && hello.data.history, 'hello carries the full state');
      await eventually('viewer counted', async () => (await getState(srv.baseUrl)).liveView.viewers > before.liveView.viewers);

      const nav = await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
      assert.equal(nav.isError, false, nav.text);

      const done = await stream.waitFor('finished navigate activity', (e) => e.type === 'activity' && e.data.tool === 'browser_navigate' && e.data.status === 'ok');
      assert.equal(typeof done.data.durationMs, 'number');
      assert.match(done.data.client ?? '', /integration-test/);
      assert.match(String(done.data.args?.url), /index\.html/);
      const running = stream.events.find((e) => e.type === 'activity' && e.data.id === done.data.id && e.data.status === 'running');
      assert.ok(running, 'a running entry precedes the result');

      const tabs = await stream.waitFor('tabs with the fixture page', (e) => e.type === 'tabs' && e.data.tabs.some((t: any) => /index\.html/.test(t.url)));
      assert.ok(tabs.data.activeTabId, 'active tab id is published');

      const frame = await stream.waitFor('screencast frame', (e) => e.type === 'frame' && typeof e.data.data === 'string' && e.data.data.length > 1000);
      assert.ok(frame.data.width > 0 && frame.data.height > 0);
      assert.match(frame.data.mimeType, /^image\/(jpeg|png)$/);
      assert.ok(frame.data.tabId);

      await stream.waitFor('document request', (e) => e.type === 'network' && /index\.html/.test(e.data.url) && e.data.state === 'done');

      const click = await srv.call('browser_click', { selector: '#counter' });
      assert.equal(click.isError, false, click.text);
      const pointer = await stream.waitFor('click marker', (e) => e.type === 'pointer' && e.data.kind === 'click');
      assert.ok(Number.isFinite(pointer.data.x) && Number.isFinite(pointer.data.y));
      assert.ok(pointer.data.x >= 0 && pointer.data.x <= frame.data.width, 'marker lies inside the viewport');
      await stream.waitFor('page console message', (e) => e.type === 'console' && /counter clicked/.test(e.data.text));

      const failed = await srv.call('browser_click', { selector: '#does-not-exist' });
      assert.equal(failed.isError, true);
      const errorEntry = await stream.waitFor('failed activity', (e) => e.type === 'activity' && e.data.status === 'error');
      assert.match(errorEntry.data.error ?? '', /not found/i);

      await stream.waitFor('log record', (e) => e.type === 'log' && typeof e.data.msg === 'string' && typeof e.data.level === 'number');
      // status carries sessions so the Sessions tab's tool-call counts stay fresh between add/remove events
      const status = await stream.waitFor(
        'status heartbeat with counted tool calls',
        (e) => e.type === 'status' && Array.isArray(e.data.sessions) && e.data.sessions.some((s: any) => s.toolCalls >= 3),
        12_000,
      );
      for (const key of ['server', 'obscura', 'browser', 'liveView']) assert.ok(status.data[key], key);
    } finally {
      await stream.close();
    }
    await eventually('viewer released', async () => (await getState(srv.baseUrl)).liveView.viewers === before.liveView.viewers);
  });

  test('the live view follows the active tab when a tab is opened and closed', async () => {
    const nav = await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    assert.equal(nav.isError, false, nav.text);
    const before = await getState(srv.baseUrl);
    const stream = openEventStream(`${srv.baseUrl}/api/events?live=1`);
    try {
      const hello = await stream.waitFor('hello', (e) => e.type === 'hello');
      assert.ok(hello.data.liveView.viewers >= 1, 'hello counts the connecting viewer');
      const firstTab = hello.data.browser.activeTabId as string;
      assert.ok(firstTab);

      const opened = await srv.call('browser_tab_new', { url: `${fx.baseUrl}/page2.html` });
      assert.equal(opened.isError, false, opened.text);
      const tabsAfterOpen = await stream.waitFor('tabs with the new tab active', (e) => e.type === 'tabs' && e.data.activeTabId !== firstTab);
      const secondTab = tabsAfterOpen.data.activeTabId as string;
      await stream.waitFor('frame of the new tab', (e) => e.type === 'frame' && e.data.tabId === secondTab);

      const mark = stream.events.length;
      const closed = await srv.call('browser_tab_close', { tabId: secondTab });
      assert.equal(closed.isError, false, closed.text);
      await stream.waitFor(
        'frame of the tab that became active again',
        (e) => stream.events.indexOf(e) >= mark && e.type === 'frame' && e.data.tabId === firstTab,
        5_000,
      );
    } finally {
      await stream.close();
    }

    // a viewer connecting now must not be sent the closed tab's picture
    const late = openEventStream(`${srv.baseUrl}/api/events?live=1`);
    try {
      const hello = await late.waitFor('hello', (e) => e.type === 'hello');
      const frame = await late.waitFor('initial frame', (e) => e.type === 'frame', 3_000).catch(() => null);
      if (frame) assert.equal(frame.data.tabId, hello.data.browser.activeTabId);
    } finally {
      await late.close();
    }
    // the next test counts viewers, so wait until the server has let both streams go
    await eventually('viewers released', async () => (await getState(srv.baseUrl)).liveView.viewers === before.liveView.viewers);
  });

  test("the snapshots API lists metadata only; DELETE needs the custom header, this server's Origin and a same-origin fetch", async () => {
    const name = `dash-${Date.now().toString(36)}`;
    const s = await signIn(srv, fx, 'dana');
    const saved = await srv.call('snapshot_save', { name, description: 'Fixture shop — dana' });
    assert.equal(saved.isError, false, saved.text);
    const stream = openEventStream(`${srv.baseUrl}/api/events`);
    try {
      const hello = await stream.waitFor('hello', (e) => e.type === 'hello');
      assert.ok(hello.data.history.snapshots?.snapshots.some((x: any) => x.name === name), 'hello carries the snapshots list');

      const api = await fetch(`${srv.baseUrl}/api/snapshots`, { headers: authHeaders() });
      assert.equal(api.status, 200);
      assert.equal(api.headers.get('cache-control'), 'no-store');
      const body = await api.json();
      assert.equal(typeof body.dir, 'string');
      assert.equal(typeof body.encrypted, 'boolean');
      assert.equal(typeof body.unencrypted_count, 'number');
      const e = body.snapshots.find((x: any) => x.name === name);
      assert.equal(e.description, 'Fixture shop — dana');
      assert.equal(e.cookie_count, 1);
      assert.equal(e.expired_count, 0);
      assert.deepEqual(e.loaded_in, ['main']);
      assert.deepEqual(e.active_in, ['main']);
      const text = JSON.stringify(body);
      assert.ok(!text.includes(s.token) && !text.includes(s.profile), 'no cookie or storage value');

      const own = new URL(srv.baseUrl).origin;
      const del = (path: string, headers: Record<string, string>) => fetch(`${srv.baseUrl}/api/snapshots/${path}`, { method: 'DELETE', headers: { ...authHeaders(), ...headers } });
      const refused: Array<[string, Record<string, string>]> = [
        ['no X-SBM-Request header', { Origin: own, 'Sec-Fetch-Site': 'same-origin' }],
        ['no Origin', { 'X-SBM-Request': '1' }],
        ['a foreign Origin', { 'X-SBM-Request': '1', Origin: 'https://evil.example' }],
        ['a cross-site fetch', { 'X-SBM-Request': '1', Origin: own, 'Sec-Fetch-Site': 'cross-site' }],
      ];
      for (const [label, headers] of refused) {
        const res = await del(name, headers);
        assert.equal(res.status, 403, label);
        assert.equal(typeof (await res.json()).error, 'string', label);
      }
      assert.match((await srv.call('snapshot_list')).text, new RegExp(`^- ${name} — `, 'm'), 'nothing was deleted');

      const good = { 'X-SBM-Request': '1', Origin: own, 'Sec-Fetch-Site': 'same-origin' };
      for (const bad of ['%2f', 'a%2fb', '%00', '.hidden', 'x'.repeat(65)]) {
        const res = await del(bad, good);
        assert.equal(res.status, 400, bad);
        assert.match((await res.json()).error, /Invalid snapshot name/, bad);
      }
      assert.equal((await del(`nope-${name}`, good)).status, 404);
      const ok = await del(name.toUpperCase(), good);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { deleted: name, loaded_in: ['main'] });
      await stream.waitFor('snapshots event without it', (ev) => ev.type === 'snapshots' && !ev.data.snapshots.some((x: any) => x.name === name));
      assert.equal((await del(name, good)).status, 404);
      assert.doesNotMatch((await srv.call('snapshot_list')).text, new RegExp(`^- ${name} — `, 'm'));
    } finally {
      await stream.close();
      await srv.call('browser_clear_cookies');
    }
  });

  test('a paused (non-live) stream receives events but no frames and is not a viewer', async () => {
    const before = await getState(srv.baseUrl);
    const stream = openEventStream(`${srv.baseUrl}/api/events`);
    try {
      await stream.waitFor('hello', (e) => e.type === 'hello');
      const nav = await srv.call('browser_navigate', { url: `${fx.baseUrl}/page2.html` });
      assert.equal(nav.isError, false, nav.text);
      await stream.waitFor('activity', (e) => e.type === 'activity' && e.data.tool === 'browser_navigate' && e.data.status === 'ok');
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(stream.events.filter((e) => e.type === 'frame').length, 0);
      assert.equal((await getState(srv.baseUrl)).liveView.viewers, before.liveView.viewers);
    } finally {
      await stream.close();
    }
  });
});
