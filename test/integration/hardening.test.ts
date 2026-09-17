import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

/** Cross-cutting guarantees: secrets stay out of logs, rejected calls are recorded, refs survive SPA routing. */
describe('hardening', () => {
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

  const rawLogs = () => {
    if (!srv.logDir) return '';
    return readFileSync(path.join(srv.logDir, 'current.log'), 'utf8');
  };
  const settle = () => new Promise((r) => setTimeout(r, 400));

  test('a password typed through a non-descriptive selector never reaches the logs; ordinary values do', { skip: !!process.env.MCP_URL }, async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/secret.html` });
    const secret = await srv.call('browser_fill', { selector: '#f2', value: 'hunter2-very-secret' });
    assert.equal(secret.isError, false, secret.text);
    assert.doesNotMatch(secret.text, /hunter2/);
    const typed = await srv.call('browser_type', { selector: '#f2', text: 'more-secret-suffix' });
    assert.equal(typed.isError, false, typed.text);
    const plain = await srv.call('browser_fill', { selector: '#f1', value: 'visible-user-name-42' });
    assert.equal(plain.isError, false, plain.text);
    await settle();
    const logs = rawLogs();
    assert.equal(logs.includes('hunter2-very-secret'), false, 'password value leaked into logs');
    assert.equal(logs.includes('more-secret-suffix'), false, 'typed password text leaked into logs');
    const resultLine = srv.logs().find((l) => l.component === 'tool' && l.tool === 'browser_fill' && typeof l.durationMs === 'number' && l.args?.selector === '#f1');
    assert.equal(resultLine?.args?.value, 'visible-user-name-42', 'non-secret values are logged in the result line');

    const state = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const activity = JSON.stringify(state.history.activity);
    assert.equal(activity.includes('hunter2-very-secret'), false, 'password value leaked into the dashboard activity feed');
    assert.ok(activity.includes('visible-user-name-42'));
  });

  test('cookie values are hidden from logs and the dashboard', { skip: !!process.env.MCP_URL }, async () => {
    const reversed = Array.from('server-cookie-secret-77').reverse().join('');
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/set-cookie?name=sid&reverse=1&httponly=1&value=${reversed}` });
    const set = await srv.call('browser_set_cookie', { name: 'manual', value: 'manual-cookie-secret-88', url: fx.baseUrl });
    assert.equal(set.isError, false, set.text);
    const got = await srv.call('browser_get_cookies');
    assert.match(got.text, /manual-cookie-secret-88/, 'the agent still receives cookie values');
    const exported = await srv.call('browser_storage_state');
    assert.match(exported.text, /server-cookie-secret-77/);
    await settle();
    const logs = rawLogs();
    assert.equal(logs.includes('manual-cookie-secret-88'), false, 'cookie set by the agent leaked into logs');
    assert.equal(logs.includes('server-cookie-secret-77'), false, 'cookie set by the server leaked into logs');
    const state = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const dashboard = JSON.stringify(state.history);
    assert.equal(dashboard.includes('manual-cookie-secret-88'), false);
    assert.equal(dashboard.includes('server-cookie-secret-77'), false);
  });

  test('tool calls rejected by input validation are logged and shown in the activity feed', async () => {
    let rejected: any;
    try {
      rejected = await srv.client.callTool({ name: 'browser_navigate', arguments: { url: 42 } });
    } catch (err) {
      rejected = { thrown: String(err) };
    }
    assert.ok(rejected.isError || rejected.thrown, 'the call is rejected');
    await settle();
    const state = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const entry = state.history.activity.find((a: any) => a.tool === 'browser_navigate' && a.status === 'error' && /valid|expected/i.test(a.error ?? ''));
    assert.ok(entry, 'rejected call appears in the activity feed');
    if (srv.logDir) assert.ok(srv.logs().some((l) => l.component === 'tool' && /rejected before running/.test(l.msg)));
  });

  test('history.pushState keeps element refs valid and is reported as a URL change', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/spa.html` });
    await srv.call('browser_wait_for', { selector: '#route' });
    const snap = await srv.call('browser_snapshot');
    const route = /ref=(e\d+)\s+button\s+"Go to route"/.exec(snap.text)?.[1];
    const load = /ref=(e\d+)\s+button\s+"Load data"/.exec(snap.text)?.[1];
    assert.ok(route && load, snap.text);
    const clicked = await srv.call('browser_click', { ref: route });
    assert.equal(clicked.isError, false, clicked.text);
    assert.match(clicked.text, /URL changed to .*\/spa\/route/);
    assert.doesNotMatch(clicked.text, /refs were reset/);
    const again = await srv.call('browser_click', { ref: load });
    assert.equal(again.isError, false, `ref from before pushState still works: ${again.text}`);
  });

  test('a real navigation still invalidates refs', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const snap = await srv.call('browser_snapshot');
    const link = /ref=(e\d+)\s+a\s+"Page Two"/.exec(snap.text)![1];
    const counter = /ref=(e\d+)\s+button\s+"Click me"/.exec(snap.text)![1];
    const nav = await srv.call('browser_click', { ref: link });
    assert.match(nav.text, /navigated to .*page2\.html/);
    const stale = await srv.call('browser_click', { ref: counter });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Unknown element ref|no longer valid/);
  });

  test('snapshot text separates table cells and skips inline-hidden elements', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const snap = await srv.call('browser_snapshot', { include_elements: false });
    assert.match(snap.text, /Product \| Price/);
    assert.match(snap.text, /Apple \| \$1/);
    assert.doesNotMatch(snap.text, /\bHidden\b/);
  });

  test('snapshot labels a checkbox from a sibling <label> without for=', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/checkbox-label.html` });
    const snap = await srv.call('browser_snapshot');
    assert.match(snap.text, /ref=e\d+\s+input\[checkbox\]\s+"Buy milk"/, snap.text);
    assert.match(snap.text, /ref=e\d+\s+input\[checkbox\]\s+"Buy eggs"/, snap.text);
  });

  test('invalid CSS selectors are reported as invalid, not as missing elements', async () => {
    const r = await srv.call('browser_click', { selector: 'div[' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Invalid or unsupported CSS selector/);
    // Obscura leniently matches an unclosed attribute selector and would click something; reject it up front
    const lenient = await srv.call('browser_click', { selector: 'div[class=quote' });
    assert.equal(lenient.isError, true, lenient.text);
    assert.match(lenient.text, /Invalid or unsupported CSS selector/);
  });

  test('a page cannot escape to a file: URL via link, form or script, and http navigation still works', async () => {
    const urlLine = (snap: string) => /^URL: (.*)$/m.exec(snap)?.[1] ?? '';

    // 1) a link to file:///etc/hosts must not leave the tab on a file: document or return its contents
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/file-escape.html` });
    const viaLink = await srv.call('browser_click', { selector: '#filelink' });
    const afterLink = await srv.call('browser_snapshot', { include_elements: false });
    assert.doesNotMatch(urlLine(afterLink.text), /^file:/, `left on a file: URL after a link click: ${afterLink.text}`);
    assert.ok(!(viaLink.text + afterLink.text).includes('broadcasthost'), 'no /etc/hosts contents were returned');

    // 2) a form whose action is file:// must not expose the file either
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/file-escape.html` });
    await srv.call('browser_click', { selector: '#filesubmit' });
    const afterForm = await srv.call('browser_snapshot', { include_elements: false });
    assert.doesNotMatch(urlLine(afterForm.text), /^file:/, `left on a file: URL after a form submit: ${afterForm.text}`);

    // 3) a script location change to file:// must not expose the file to a follow-up read
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/file-escape.html` });
    await srv.call('browser_evaluate', { expression: `location.href = 'file:///etc/hosts'` });
    const afterJs = await srv.call('browser_snapshot', { include_elements: false });
    assert.doesNotMatch(urlLine(afterJs.text), /^file:/, `left on a file: URL after a script navigation: ${afterJs.text}`);
    const readBack = await srv.call('browser_get_text', { selector: 'body' });
    assert.ok(!readBack.text.includes('broadcasthost'), 'get_text did not return /etc/hosts contents');

    // 4) a normal http link still navigates
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/file-escape.html` });
    const okNav = await srv.call('browser_click', { selector: '#oklink' });
    assert.equal(okNav.isError, false, okNav.text);
    assert.match(okNav.text, /navigated to .*page2\.html/);
  });

  test('a call waiting behind another is shown as queued, then runs', async () => {
    const slow = srv.call('browser_navigate', { url: `${fx.baseUrl}/slow?ms=1500` });
    await settle();
    const waiting = srv.call('browser_evaluate', { expression: '"queued-marker"' });
    await settle();
    const mid = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const queuedEntry = mid.history.activity.find((a: any) => a.tool === 'browser_evaluate' && a.status === 'queued');
    assert.ok(queuedEntry, 'the waiting call is reported as queued');
    await Promise.all([slow, waiting]);
    const after = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    const done = after.history.activity.find((a: any) => a.id === queuedEntry.id);
    assert.equal(done.status, 'ok');
    assert.ok(done.queuedMs >= 500, `queuedMs=${done.queuedMs}`);
    assert.ok(done.durationMs < 1000, 'duration counts only the time the call actually ran');
  });

  test('a multi-line engine message (stack trace) is logged as one record', { skip: !!process.env.MCP_URL }, async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/console.html` });
    await new Promise((r) => setTimeout(r, 800));
    const engine = srv.logs().filter((l) => l.component === 'obscura-engine');
    const multi = engine.find((l) => typeof l.lines === 'number' && l.lines > 1 && String(l.msg).includes('\n'));
    assert.ok(multi, `expected a merged multi-line record, got: ${JSON.stringify(engine.slice(-5).map((l) => l.msg))}`);
    assert.ok(!engine.some((l) => /^\s+at /.test(String(l.msg))), 'stack frames are not logged as separate records');
  });

  test('tools/list advertises each tool group in _meta', async () => {
    const { tools } = await srv.client.listTools();
    const nav = tools.find((t) => t.name === 'browser_navigate') as any;
    assert.equal(nav._meta?.['stealth-browser-mcp/group'], 'core');
  });
});
