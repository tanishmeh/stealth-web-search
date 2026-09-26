import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, type Chrome, type Page } from '../helpers/chrome.ts';
import { startFakeLlm, type FakeLlm, type FakeTurn } from '../helpers/fake-llm.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

/**
 * The dashboard, driven in a real (headless) Chrome the way a person uses it: every control is
 * clicked or typed into, and every view is checked against what the server did. The tests only
 * rely on element ids, roles and data attributes, not on class names or styling, so they hold for
 * any design of the page. Skipped when no Chrome is installed (set CHROME_PATH to use another).
 */

const CHROME = findChrome();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** A server on a fixed port, so it can be stopped and started again at the same address. */
async function spawnServer(port: number, extraEnv: Record<string, string> = {}): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOG_DIR: mkdtempSync(path.join(tmpdir(), 'sws-ui-logs-')), LOG_FORMAT: 'json', LOG_LEVEL: 'warn', AGENT_MODELS_FILE: 'none', SBM_EXIT_WITH_PARENT: '1', ...extraEnv },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('the server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ reasoning: `Thinking about ${name}.`, toolCalls: [{ name, arguments: args }] });

describe('dashboard UI', { skip: CHROME ? false : 'no Chrome found (set CHROME_PATH)' }, () => {
  let chrome: Chrome;
  let page: Page;
  let srv: TestServer;
  let site: FixtureServer;
  let llm: FakeLlm;
  const visible = (id: string) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el || el.hidden) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })()`;
  const text = (id: string) => page.eval<string>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? ''`);
  const count = (selector: string) => page.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const shown = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => !e.hidden && e.getClientRects().length > 0)`;
  const openTab = async (view: string) => {
    await page.click(`#inspector [role="tab"][data-view="${view}"]`);
    await page.waitFor(`${view} view`, `${visible(`view-${view}`)} && document.querySelector('[data-view="${view}"]').getAttribute('aria-selected') === 'true'`);
  };
  const select = (id: string, value: string) =>
    page.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const typeInto = (id: string, value: string) =>
    page.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.focus(); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  before(async () => {
    site = await startFixtureServer();
    llm = await startFakeLlm((req) => {
      const task = JSON.stringify(req.messages);
      if (task.includes('AUTOMATE-UI')) {
        switch (req.step) {
          case 1:
            return call('browser_navigate', { url: `${site.baseUrl}/catalog.html?q=apple` });
          case 2:
            return call('script_save', {
              name: 'ui-catalog',
              description: 'Read the product names of the gadget catalog.',
              params: [{ name: 'query', type: 'string', description: 'Search text', example: 'apple' }],
              output_description: 'The product names',
              code: `async function run(params) { await browser.goto(${JSON.stringify(site.baseUrl)} + '/catalog.html?q=' + encodeURIComponent(params.query)); return (await browser.extract({ 'names[]': '.product .name' })).names; }`,
            });
          case 3:
            return call('script_test', {});
          default:
            return call('finish', { output: 'saved', verified: true });
        }
      }
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: `${site.baseUrl}/index.html` });
        case 2:
          return { ...call('browser_snapshot', {}), delayMs: 1500 };
        default:
          return call('finish', { output: 'UI-AGENT-DONE' });
      }
    });
    srv = await startTestServer({ AGENT_LLM_URL: llm.url, AGENT_LLM_MODEL: 'fake-model', SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sws-ui-scripts-')), LOG_FILE_LEVEL: 'debug' });
    chrome = await launchChrome(CHROME!);
    page = await chrome.newPage(1440, 900);
    await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: srv.baseUrl }).catch(() => undefined);
    await page.navigate(`${srv.baseUrl}/`);
    await page.waitFor('the event stream', `document.getElementById('app').dataset.conn === 'open'`);
  });

  after(async () => {
    await chrome?.close();
    await srv?.stop();
    await llm?.close();
    await site?.close();
  });

  test('loads, connects and shows the server details', async () => {
    assert.match(await page.eval<string>('document.title'), /Stealth Web Search/);
    await page.waitFor('the version', `/^v\\d/.test(document.getElementById('version').textContent.trim())`);
    assert.equal((await text('mcp-url')).trim(), `${srv.baseUrl}/mcp`);
    await page.waitFor('engine status', `/ready/i.test(document.getElementById('pill-obscura').textContent)`);
    await page.waitFor('CDP status', `/connected|idle|CDP/i.test(document.getElementById('pill-cdp').textContent)`);
    await page.waitFor('stealth status', `/stealth on/i.test(document.getElementById('pill-stealth').textContent)`);
    await page.waitFor('viewer count', `/1 viewer/.test(document.getElementById('pill-viewers').textContent)`);
    await page.waitFor('client count', `/1 MCP client/.test(document.getElementById('pill-clients').textContent)`);
    await page.waitFor('uptime', `/Up \\d/.test(document.getElementById('pill-uptime').textContent)`);
    assert.match(await text('pill-conn'), /Live/);
  });

  test('before any page is open, the live view explains why it is empty', async () => {
    assert.equal(await page.eval(visible('stage-overlay')), true);
    assert.ok((await text('overlay-title')).trim().length > 0);
    assert.equal(await page.eval(`document.getElementById('screen').hidden`), true);
    assert.equal(await page.eval(`document.getElementById('btn-shot').getAttribute('aria-disabled')`), 'true');
  });

  test('the live view shows the page, its URL, title and tab', async () => {
    const r = await srv.call('browser_navigate', { url: `${site.baseUrl}/index.html` });
    assert.equal(r.isError, false, r.text);
    await page.waitFor('the frame', visible('screen'), 20_000);
    await page.waitFor(
      'a drawn frame',
      `(() => { const c = document.getElementById('frame'); if (!c.width) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let set = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] < 740) set++; return set > 20; })()`,
      20_000,
    );
    await page.waitFor('the URL', `document.getElementById('omnibox-url').textContent.includes('/index.html')`);
    await page.waitFor('the title', `document.getElementById('omnibox-title').textContent.length > 0`);
    await page.waitFor('one tab', `document.querySelectorAll('#tabstrip [role="tab"], #tabstrip > *').length >= 1`);
    await page.waitFor('frame status', `/Live|Idle/.test(document.getElementById('framemeta-text').textContent)`);
    assert.equal(await page.eval(`document.getElementById('btn-shot').getAttribute('aria-disabled')`), null);
  });

  test('clicks on the page show a marker', async () => {
    await srv.call('browser_navigate', { url: `${site.baseUrl}/form.html` });
    const before = await count('#markers > *');
    const snap = await srv.call('browser_snapshot', {});
    const ref = /ref=(e\d+)\s+(?:button|link)/i.exec(snap.text)?.[1] ?? /ref=(e\d+)/.exec(snap.text)?.[1];
    assert.ok(ref, snap.text);
    await srv.call('browser_click', { ref });
    await page.waitFor('a click marker', `document.querySelectorAll('#markers > *').length > ${before}`, 10_000);
  });

  test('a running tool shows the working banner', async () => {
    const pending = srv.call('browser_wait', { seconds: 2 });
    await page.waitFor('the working banner', `${visible('working')} && document.getElementById('working-tool').textContent.includes('browser_wait')`);
    await pending;
    await page.waitFor('the banner to hide', `document.getElementById('working').hidden`);
  });

  test('pause and resume with the button and the P key', async () => {
    await page.click('#btn-pause');
    await page.waitFor('paused', `document.getElementById('btn-pause').getAttribute('aria-pressed') === 'true' && /Paused/.test(document.getElementById('pill-conn').textContent)`);
    await page.eval('document.body.focus()');
    await page.press('p');
    await page.waitFor('resumed', `document.getElementById('btn-pause').getAttribute('aria-pressed') === 'false' && /Live/.test(document.getElementById('pill-conn').textContent)`);
  });

  test('fullscreen with the button and the F key', async () => {
    // headless Chrome has no real fullscreen: record the request and report the change like the browser would
    await page.eval(`(() => {
      window.__fs = 0;
      Element.prototype.requestFullscreen = function () { window.__fs++; Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => this }); document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
      document.exitFullscreen = function () { window.__fs--; Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null }); document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
      return true;
    })()`);
    await page.click('#btn-fullscreen');
    await page.waitFor('fullscreen on', `window.__fs === 1 && document.getElementById('btn-fullscreen').getAttribute('aria-pressed') !== 'false'`);
    await page.eval('document.body.focus()');
    await page.press('f');
    await page.waitFor('fullscreen off', `window.__fs === 0`);
  });

  test('the screenshot button opens a PNG of the watched browser', async () => {
    await page.eval(`document.getElementById('btn-shot').addEventListener('click', (e) => e.preventDefault(), { once: true })`);
    await page.click('#btn-shot');
    const href = await page.eval<string>(`document.getElementById('btn-shot').href`);
    assert.match(href, /\/api\/screenshot\?browser=main/);
    const res = await fetch(href);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  test('activity lists every tool call; entries expand; tool and error filters work', async () => {
    await srv.call('browser_click', { selector: '#definitely-missing' }).catch(() => undefined);
    await page.waitFor('an error entry', `[...document.querySelectorAll('#activity-list > li')].some((li) => li.dataset.status === 'error')`);
    const total = await count('#activity-list > li');
    assert.ok(total >= 4, `entries: ${total}`);
    assert.match(await text('activity-count'), new RegExp(String(total)));
    await page.click('#activity-list > li:last-child button[aria-expanded]');
    await page.waitFor('an expanded entry', `document.querySelector('#activity-list > li:last-child button[aria-expanded]').getAttribute('aria-expanded') === 'true' && [...document.querySelectorAll('#activity-list > li:last-child *')].some((e) => !e.hidden && /url/.test(e.textContent) && e.getClientRects().length)`);
    await select('activity-tool', 'browser_navigate');
    await page.waitFor('the tool filter', `${shown('#activity-list > li')}.length > 0 && ${shown('#activity-list > li')}.every((li) => li.textContent.includes('navigate'))`);
    await select('activity-tool', '');
    await page.click('#activity-errors');
    await page.waitFor('the errors filter', `${shown('#activity-list > li')}.length > 0 && ${shown('#activity-list > li')}.every((li) => li.dataset.status === 'error')`);
    await page.click('#activity-errors');
    await page.waitFor('all entries again', `${shown('#activity-list > li')}.length === document.querySelectorAll('#activity-list > li').length`);
  });

  test('inspector tabs switch with clicks and arrow keys', async () => {
    for (const view of ['network', 'logs', 'sessions', 'agents', 'console']) await openTab(view);
    await page.eval(`document.querySelector('#inspector [data-view="console"]').focus()`);
    await page.press('ArrowRight');
    await page.waitFor('the next tab', `document.querySelector('[data-view="network"]').getAttribute('aria-selected') === 'true' && ${visible('view-network')}`);
    await page.press('ArrowLeft');
    await page.waitFor('the previous tab', `document.querySelector('[data-view="console"]').getAttribute('aria-selected') === 'true'`);
  });

  test('console: messages, level filter, search, follow, clear', async () => {
    await openTab('console');
    await srv.call('browser_navigate', { url: `${site.baseUrl}/console.html` });
    await page.waitFor('console rows', `document.querySelectorAll('#console-rows > *').length >= 4`);
    const all = await count('#console-rows > *');
    assert.ok(Number(await text('count-console')) >= 4);
    await select('console-level', 'error');
    await page.waitFor('errors only', `${shown('#console-rows > *')}.length > 0 && ${shown('#console-rows > *')}.length < ${all}`);
    await select('console-level', 'all');
    await typeInto('console-search', 'a warning');
    await page.waitFor('the search', `${shown('#console-rows > *')}.length === 1`);
    await typeInto('console-search', '');
    await page.waitFor('all rows', `${shown('#console-rows > *')}.length >= ${all}`);
    await page.click('#console-follow');
    await page.waitFor('follow off', `document.getElementById('console-follow').getAttribute('aria-pressed') === 'false'`);
    await page.click('#console-follow');
    await page.click('#console-clear');
    await page.waitFor('a cleared console', `${shown('#console-rows > *')}.length === 0 && ${visible('console-empty')}`);
  });

  test('network: requests, failed and type filters, search, clear', async () => {
    await openTab('network');
    await srv.call('browser_navigate', { url: `${site.baseUrl}/network.html` });
    await page.waitFor('network rows', `document.querySelectorAll('#network-rows > *').length >= 3`);
    const all = await count('#network-rows > *');
    await page.click('#network-failed');
    await page.waitFor('failed only', `${shown('#network-rows > *')}.length > 0 && ${shown('#network-rows > *')}.every((r) => r.textContent.includes('404'))`);
    await page.click('#network-failed');
    await select('network-type', 'css');
    await page.waitFor('stylesheets only', `${shown('#network-rows > *')}.length >= 1 && ${shown('#network-rows > *')}.every((r) => r.textContent.includes('.css'))`);
    await select('network-type', '');
    await typeInto('network-search', 'network-script');
    await page.waitFor('the search', `${shown('#network-rows > *')}.length === 1`);
    await typeInto('network-search', '');
    await page.waitFor('all rows', `${shown('#network-rows > *')}.length === ${all}`);
    assert.ok((await text('network-foot')).length > 0, 'the footer shows totals');
    await page.click('#network-clear');
    await page.waitFor('a cleared list', `document.querySelectorAll('#network-rows > *').length === 0`);
  });

  test('logs: lines, level and component filters, search, details, download', async () => {
    await openTab('logs');
    await page.waitFor('log rows', `document.querySelectorAll('#logs-rows > *').length > 0`);
    await select('logs-level', 'debug');
    await page.waitFor('debug lines', `document.querySelectorAll('#logs-rows > *').length > 0`);
    const debug = await count('#logs-rows > *');
    await select('logs-level', 'warn');
    await page.waitFor('fewer lines', `document.querySelectorAll('#logs-rows > *').length < ${debug}`);
    await select('logs-level', 'debug');
    await page.waitFor('components', `[...document.getElementById('logs-component').options].some((o) => o.value === 'tool')`);
    await select('logs-component', 'tool');
    await page.waitFor('tool lines only', `document.querySelectorAll('#logs-rows > *').length > 0 && [...document.querySelectorAll('#logs-rows > *')].every((r) => r.textContent.includes('tool'))`);
    await typeInto('logs-search', 'browser_navigate');
    await page.waitFor('the search', `document.querySelectorAll('#logs-rows > *').length > 0 && [...document.querySelectorAll('#logs-rows > *')].every((r) => r.textContent.includes('browser_navigate'))`);
    const before = await page.eval<number>(`document.querySelector('#logs-rows > *').getBoundingClientRect().height`);
    await page.click('#logs-rows > *:first-child');
    await page.waitFor('details', `document.querySelector('#logs-rows > *').getBoundingClientRect().height > ${before} + 20 && /"tool"/.test(document.querySelector('#logs-rows > *').textContent)`);
    await select('logs-component', '');
    await typeInto('logs-search', '');
    const href = await page.eval<string>(`document.getElementById('logs-download').href`);
    const res = await fetch(href);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('"component"'));
  });

  test('sessions list the connected MCP client', async () => {
    await openTab('sessions');
    await page.waitFor('a session row', `[...document.querySelectorAll('#sessions-rows > *')].some((r) => r.textContent.includes('integration-test'))`);
    assert.ok(Number(await text('count-sessions')) >= 1);
    assert.ok((await text('server-foot')).length > 0, 'the footer shows server details');
  });

  test('agents: a run card, its details, and watching its browser live', async () => {
    await openTab('agents');
    const started = await srv.call('agent_run', { task: 'Open the fixture index page', output: 'done', wait_seconds: 0 });
    const runId = started.raw.structuredContent.run_id as string;
    await page.waitFor('the run card', `!!document.querySelector('#agents-rows [data-id="${runId}"]')`);
    await page.waitFor('a Watch button', `!!document.querySelector('#agents-rows [data-id="${runId}"] [data-action="watch"]:not([disabled])')`, 20_000);
    await page.click(`#agents-rows [data-id="${runId}"] [data-action="watch"]`);
    await page.waitFor('the agent browser in the live view', `document.getElementById('browser-select').value === 'agent-${runId}'`);
    await page.waitFor('the agent page', `document.getElementById('omnibox-url').textContent.includes('/index.html') || /closed/i.test(document.getElementById('overlay-title').textContent)`, 20_000);
    await page.waitFor('the finished run', `document.querySelector('#agents-rows [data-id="${runId}"]').textContent.includes('UI-AGENT-DONE')`, 30_000);
    await page.click(`#agents-rows [data-id="${runId}"] [data-action="details"]`);
    await page.waitFor('the steps', `document.querySelector('#agents-rows [data-id="${runId}"] [data-action="details"]').getAttribute('aria-expanded') === 'true' && document.querySelector('#agents-rows [data-id="${runId}"]').textContent.includes('browser_navigate')`);
    assert.match(await text('agents-foot'), /fake-model/);
    // the picker lists the agent's browser, and switching back works
    assert.equal(await page.eval(`[...document.getElementById('browser-select').options].some((o) => o.value === 'agent-${runId}')`), true);
    await select('browser-select', 'main');
    await page.waitFor('the main browser', `document.getElementById('omnibox-url').textContent.includes('/network.html')`);
  });

  test('stored scripts are listed after agent_automate', async () => {
    const r = await srv.call('agent_automate', { task: 'AUTOMATE-UI read the catalog', output: 'names', parameters: 'query', wait_seconds: 60 });
    assert.equal(r.isError, false, r.text);
    await page.eval(`(() => { const t = document.querySelector('#inspector [data-view="console"]'); t.click(); return true; })()`);
    await openTab('agents'); // opening the tab reloads the list
    await page.waitFor('the script row', `[...document.querySelectorAll('#scripts-rows > *')].some((r) => r.textContent.includes('ui-catalog'))`, 30_000);
    assert.equal(await text('count-scripts'), '1');
  });

  test('the splitter resizes the panels with the mouse and the keyboard', async () => {
    const box = await page.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.getElementById('splitter').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
    const height = () => page.eval<number>(`document.getElementById('inspector').getBoundingClientRect().height`);
    const before = await height();
    await page.drag({ x: box.x, y: box.y }, { x: box.x, y: box.y - 120 });
    await page.waitFor('a taller inspector', `document.getElementById('inspector').getBoundingClientRect().height > ${before} + 60`);
    await page.eval(`document.getElementById('splitter').focus()`);
    const mid = await height();
    await page.press('ArrowDown');
    await page.waitFor('keyboard resize', `Math.abs(document.getElementById('inspector').getBoundingClientRect().height - ${mid}) > 5`);
    const saved = await page.eval<string | null>(`localStorage.getItem('sbm.split')`);
    assert.ok(saved, 'the split is remembered');
  });

  test('the theme switch cycles and is remembered', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await page.click('#theme-toggle');
      seen.add((await page.eval<string | null>(`document.documentElement.getAttribute('data-theme')`)) ?? 'system');
    }
    assert.deepEqual([...seen].sort(), ['dark', 'light', 'system']);
    await page.click('#theme-toggle'); // dark
    const theme = await page.eval<string | null>(`document.documentElement.getAttribute('data-theme')`);
    await page.navigate(`${srv.baseUrl}/`);
    await page.waitFor('the event stream', `document.getElementById('app').dataset.conn === 'open'`);
    assert.equal(await page.eval(`document.documentElement.getAttribute('data-theme')`), theme);
    const bg = await page.eval<string>(`getComputedStyle(document.body).backgroundColor`);
    await page.click('#theme-toggle'); // light
    await page.waitFor('a different background', `getComputedStyle(document.body).backgroundColor !== ${JSON.stringify(bg)}`);
  });

  test('the MCP URL copies to the clipboard', async () => {
    await page.click('#copy-mcp');
    const copied = await page.eval<string>(`navigator.clipboard.readText().catch(() => '')`);
    if (copied) assert.equal(copied, (await text('mcp-url')).trim());
    else await page.waitFor('copy feedback', `document.getElementById('copy-mcp').title !== 'Copy MCP endpoint URL'`, 3_000);
  });

  test('the page reconnects by itself after a server restart', async () => {
    const port = await freePort();
    let server = await spawnServer(port);
    const p2 = await chrome.newPage(1280, 800);
    try {
      await p2.navigate(`http://127.0.0.1:${port}/`);
      await p2.waitFor('the event stream', `document.getElementById('app').dataset.conn === 'open'`, 20_000);
      await server.stop();
      await p2.waitFor('reconnecting', `/Reconnect|Connecting/i.test(document.getElementById('pill-conn').textContent) && ${visible('stage-overlay')}`, 20_000);
      server = await spawnServer(port);
      await p2.waitFor('live again', `document.getElementById('app').dataset.conn === 'open' && /Live/.test(document.getElementById('pill-conn').textContent)`, 40_000);
      assert.deepEqual(p2.problems.filter((p) => !/ERR_CONNECTION_REFUSED|Failed to load resource|EventSource/i.test(p)), []);
    } finally {
      await server.stop();
    }
  });

  test('on a narrow screen nothing scrolls sideways and every panel is reachable', async () => {
    await page.setViewport(390, 844);
    await page.navigate(`${srv.baseUrl}/`);
    await page.waitFor('the event stream', `document.getElementById('app').dataset.conn === 'open'`);
    await page.waitFor('layout', `document.documentElement.scrollWidth <= innerWidth + 1`);
    for (const id of ['live-panel', 'activity-panel', 'inspector', 'mcp-url']) {
      const w = await page.eval<number>(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().width`);
      assert.ok(w > 0, `${id} has no width`);
    }
    await page.setViewport(1440, 900);
  });

  test('with AUTH_TOKEN, a wrong token is refused and the right one connects', async () => {
    const port = await freePort();
    const guarded = await spawnServer(port, { AUTH_TOKEN: 'ui-secret-token' });
    const base = `http://127.0.0.1:${port}`;
    const p2 = await chrome.newPage(1280, 800);
    try {
      assert.equal((await fetch(`${base}/?token=wrong`)).status, 401);
      assert.equal((await fetch(`${base}/`)).status, 401);
      await p2.navigate(`${base}/?token=ui-secret-token`);
      await p2.waitFor('connected', `document.getElementById('app')?.dataset.conn === 'open'`, 20_000);
      await p2.waitFor('live', `/Live/.test(document.getElementById('pill-conn').textContent)`);
      assert.deepEqual(p2.problems, []);
    } finally {
      await guarded.stop();
    }
  });

  test('no uncaught errors or console errors on the page', () => {
    assert.deepEqual(page.problems, []);
  });
});
