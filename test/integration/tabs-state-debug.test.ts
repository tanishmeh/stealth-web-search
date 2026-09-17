import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { asyncBodyCandidates, objectLiteralCandidate, statementBoundaries } from '../../src/tools/debug.ts';
import { compactJson } from '../../src/tools/format.ts';
import { domainFromInput } from '../../src/tools/state.ts';
import { normalizeTabId } from '../../src/tools/tabs.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Result lines of a listing, without notes/headers. */
const entryLines = (text: string, prefix = '[') => text.split('\n').filter((l) => l.startsWith(prefix));

describe('evaluate code splitting (pure)', () => {
  test('finds top-level statement boundaries outside strings, comments, templates and brackets', () => {
    const src = 'const a = "x;y"; // c;\nconst b = `t${ {k: 1}.k };`\nfoo(a,\n b)\n[1, 2]';
    const cut = statementBoundaries(src).map((p) => src.slice(p).trim().split('\n')[0]);
    assert.deepEqual(cut, ['// c;', 'const b = `t${ {k: 1}.k };`', 'foo(a,']);
  });

  test('builds async bodies that return the last expression', () => {
    assert.equal(asyncBodyCandidates('await x')[0], 'return (\nawait x\n);');
    const multi = asyncBodyCandidates('const r = await f()\nconst j = await r.json()\nj.items');
    assert.equal(multi[0], 'const r = await f()\nconst j = await r.json()\n\nreturn (\nj.items\n);');
    assert.equal(multi.at(-1), 'const r = await f()\nconst j = await r.json()\nj.items');
    // a trailing declaration has no value to return: after the (invalid) expression form comes the code as written
    assert.deepEqual(asyncBodyCandidates('await f(); const z = 1;').slice(1), ['await f(); const z = 1;']);
  });

  test('object-literal candidates only for code wrapped in braces', () => {
    assert.equal(objectLiteralCandidate(' {a: 1}; '), '(\n{a: 1}\n)');
    assert.equal(objectLiteralCandidate('{}'), '(\n{}\n)');
    assert.equal(objectLiteralCandidate('({a: 1})'), null);
    assert.equal(objectLiteralCandidate('{a: 1} // note'), null);
  });
});

describe('state, tabs and format helpers (pure)', () => {
  test('compactJson keeps short values inline, packs primitive arrays and stays valid JSON', () => {
    const value = { name: 'x', list: Array.from({ length: 60 }, (_, i) => i), nested: { deep: [{ a: 1 }, { b: 'two' }] }, skip: undefined, when: new Date(0) };
    const text = compactJson(value, 40);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(value)));
    assert.ok(text.split('\n').every((line) => line.length <= 40), text);
    assert.match(text, /^ {4}"deep": \[\{"a":1\},\{"b":"two"\}\]$/m);
    assert.match(text, /^ {4}0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,$/m);
    assert.equal(compactJson({ a: [1, 2] }), '{"a":[1,2]}');
    assert.equal(compactJson([]), '[]');
    assert.equal(compactJson('s'), '"s"');
  });

  test('domainFromInput accepts domains, URLs, host:port and IPv6 literals', () => {
    assert.equal(domainFromInput('.Example.COM'), 'example.com');
    assert.equal(domainFromInput('https://www.example.com:8443/path?q'), 'www.example.com');
    assert.equal(domainFromInput('localhost:3000/app'), 'localhost');
    assert.equal(domainFromInput('[::1]'), '[::1]');
    assert.equal(domainFromInput('[::1]:8080'), '[::1]');
    assert.equal(domainFromInput('http://[::1]:8080/'), '[::1]');
  });

  test('normalizeTabId accepts common spellings', () => {
    assert.equal(normalizeTabId(' Tab_2 '), 'tab-2');
    assert.equal(normalizeTabId('tab-02'), 'tab-2');
    assert.equal(normalizeTabId('3'), 'tab-3');
    assert.equal(normalizeTabId('tab 4'), 'tab-4');
    assert.equal(normalizeTabId('foo'), 'foo');
  });
});

describe('tabs, state, debug and capture tools', () => {
  let fx: FixtureServer;
  let srv: TestServer;
  let origin: string;
  let host: string;
  const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  before(async () => {
    fx = await startFixtureServer();
    origin = new URL(fx.baseUrl).origin;
    // 127.0.0.1 locally, host.docker.internal when testing the container (FIXTURE_HOST)
    host = new URL(fx.baseUrl).hostname;
    // a short JS watchdog keeps the runaway-script tests fast
    srv = await startTestServer({ OBSCURA_JS_WATCHDOG_MS: '4000' });
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  test('registers the tools with schemas', async () => {
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'browser_tab_new',
      'browser_tab_list',
      'browser_tab_switch',
      'browser_tab_close',
      'browser_close',
      'browser_get_cookies',
      'browser_set_cookie',
      'browser_clear_cookies',
      'browser_storage_state',
      'browser_set_storage_state',
      'browser_evaluate',
      'browser_console_messages',
      'browser_network_requests',
      'browser_pdf',
      'browser_set_viewport',
    ]) {
      assert.ok(names.includes(name), name);
    }
    const evaluate = tools.find((t) => t.name === 'browser_evaluate')!;
    assert.deepEqual(evaluate.inputSchema.required, ['expression']);
    assert.deepEqual(tools.find((t) => t.name === 'browser_set_cookie')!.inputSchema.required, ['name', 'value']);
  });

  const FRESH_SERVER_ONLY = process.env.MCP_URL ? 'needs a fresh server started by the harness (not available with MCP_URL)' : false;

  test('tab lifecycle: open, list, switch, close active, close all', { skip: FRESH_SERVER_ONLY }, async () => {
    await srv.call('browser_close'); // a shared server (MCP_URL) may still have tabs from earlier suites
    assert.equal((await srv.call('browser_tab_list')).text, 'No tabs open.');

    const first = await srv.call('browser_tab_new', { url: `${fx.baseUrl}/index.html` });
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /^Opened tab-1 and navigated to http:\/\/.+\/index\.html — "Fixture Home" \(HTTP 200\)$/);

    const second = await srv.call('browser_tab_new');
    assert.equal(second.text, 'Opened tab-2 (about:blank); it is now the active tab.');
    const nav = await srv.call('browser_navigate', { url: `${fx.baseUrl}/page2.html` });
    assert.equal(nav.isError, false, nav.text);

    const list = await srv.call('browser_tab_list');
    assert.deepEqual(list.text.split('\n'), [`  tab-1  ${fx.baseUrl}/index.html  "Fixture Home"`, `* tab-2  ${fx.baseUrl}/page2.html  "Page Two"`]);

    const sw = await srv.call('browser_tab_switch', { tab_id: 'tab-1' });
    assert.equal(sw.text, `Active tab: tab-1 — ${fx.baseUrl}/index.html "Fixture Home"`);
    assert.equal((await srv.call('browser_evaluate', { expression: 'document.title' })).text, 'Fixture Home');
    assert.match((await srv.call('browser_tab_list')).text, /^\* tab-1 /);

    assert.match((await srv.call('browser_tab_switch', { tab_id: 'Tab-02' })).text, /^Active tab: tab-2 /);
    assert.match((await srv.call('browser_tab_switch', { tab_id: '1' })).text, /^Active tab: tab-1 /);
    const missing = await srv.call('browser_tab_switch', { tab_id: 'tab-9' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No such tab: tab-9\. Open tabs: tab-1, tab-2/);

    const closeActive = await srv.call('browser_tab_close');
    assert.equal(closeActive.text, 'Closed tab-1. Active tab is now tab-2.');
    assert.equal((await srv.call('browser_evaluate', { expression: 'location.pathname' })).text, '/page2.html');

    const closeLast = await srv.call('browser_tab_close', { tab_id: '2' });
    assert.equal(closeLast.text, 'Closed tab-2. No tabs remain.');
    assert.equal((await srv.call('browser_tab_list')).text, 'No tabs open.');
    const nothing = await srv.call('browser_tab_close');
    assert.equal(nothing.isError, true);
    assert.match(nothing.text, /No tab to close/);

    // the next page tool opens a fresh tab automatically
    assert.equal((await srv.call('browser_evaluate', { expression: 'location.href' })).text, 'about:blank');
    assert.equal((await srv.call('browser_tab_list')).text, '* tab-3  about:blank  ""');

    await srv.call('browser_tab_new', { url: `${fx.baseUrl}/page2.html` });
    const closeAll = await srv.call('browser_close');
    assert.equal(closeAll.text, 'Closed 2 tab(s). A fresh tab opens automatically on the next browser tool call.');
    assert.equal((await srv.call('browser_tab_list')).text, 'No tabs open.');
    assert.match((await srv.call('browser_close')).text, /^No tabs were open\./);

    const bad = await srv.call('browser_tab_new', { url: 'file:///etc/passwd' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not allowed/);
    assert.equal((await srv.call('browser_tab_list')).text, 'No tabs open.', 'no tab is opened for a rejected URL');
  });

  test('cookies: server-set HttpOnly cookie, set/get/filter, shared across tabs, clear', async () => {
    const setByServer = await srv.call('browser_navigate', { url: `${fx.baseUrl}/set-cookie?name=srv&value=abc&httponly=1` });
    assert.equal(setByServer.isError, false, setByServer.text);

    const got = await srv.call('browser_get_cookies');
    const srvCookie = JSON.parse(entryLines(got.text, '{').find((l) => l.includes('"srv"'))!);
    assert.deepEqual(srvCookie, { name: 'srv', value: 'abc', domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' });
    assert.equal((await srv.call('browser_evaluate', { expression: 'document.cookie' })).text, '', 'HttpOnly cookie hidden from page JS');

    const js = await srv.call('browser_set_cookie', { name: 'js', value: '1' });
    assert.equal(js.text, `Set cookie js for ${host}/ (SameSite=Lax, session)`);
    assert.equal((await srv.call('browser_evaluate', { expression: 'document.cookie' })).text, 'js=1');

    const expires = Math.floor(Date.now() / 1000) + 3600;
    const ext = await srv.call('browser_set_cookie', { name: 'ext', value: 'x', domain: '.Example.com', secure: true, same_site: 'Strict', expires });
    assert.equal(ext.isError, false, ext.text);
    assert.match(ext.text, /^Set cookie ext for example\.com\/ \(Secure, SameSite=Strict, expires \d{4}-\d\d-\d\dT/);
    const sub = await srv.call('browser_set_cookie', { name: 'sub', value: 'y', url: 'https://www.example.com/app', path: '/app', http_only: true });
    assert.equal(sub.text, 'Set cookie sub for www.example.com/app (HttpOnly, SameSite=Lax, session)');

    const byDomain = await srv.call('browser_get_cookies', { domain: 'example.com' });
    assert.deepEqual(entryLines(byDomain.text, '{').map((l) => JSON.parse(l).name), ['ext', 'sub']);
    assert.equal(JSON.parse(entryLines(byDomain.text, '{')[0]!).expires, expires);
    const bySubdomain = await srv.call('browser_get_cookies', { domain: 'https://www.example.com/' });
    assert.deepEqual(entryLines(bySubdomain.text, '{').map((l) => JSON.parse(l).name), ['sub']);
    const byName = await srv.call('browser_get_cookies', { name: 'srv' });
    assert.equal(entryLines(byName.text, '{').length, 1);
    assert.equal((await srv.call('browser_get_cookies', { domain: 'nothing.test' })).text, 'No cookies.');

    // cookies are shared by all tabs and sent to the server
    await srv.call('browser_tab_new', { url: `${fx.baseUrl}/echo?from=tab2` });
    const echo = fx.requests.filter((r) => r.url === '/echo?from=tab2').at(-1)!;
    assert.match(String(echo.headers.cookie), /srv=abc/);
    assert.match(String(echo.headers.cookie), /js=1/);
    await srv.call('browser_tab_close');

    const expired = await srv.call('browser_set_cookie', { name: 'js', value: 'gone', domain: host, expires: 1000 });
    assert.match(expired.text, /expiry in the past, so it was removed/);
    assert.equal((await srv.call('browser_get_cookies', { name: 'js' })).text, 'No cookies.');

    const v6 = await srv.call('browser_set_cookie', { name: 'v6', value: '1', domain: '[::1]' });
    assert.equal(v6.text, 'Set cookie v6 for [::1]/ (SameSite=Lax, session)');
    assert.equal(JSON.parse((await srv.call('browser_get_cookies', { domain: 'http://[::1]:8080/x' })).text).domain, '[::1]');
    await srv.call('browser_set_cookie', { name: 'v6', value: '1', domain: '[::1]', expires: 1000 });

    const badUrl = await srv.call('browser_set_cookie', { name: 'x', value: '1', url: 'javascript:alert(1)' });
    assert.equal(badUrl.isError, true);
    const badName = await srv.call('browser_set_cookie', { name: 'a b', value: '1', domain: 'example.com' });
    assert.equal(badName.isError, true);

    const cleared = await srv.call('browser_clear_cookies');
    assert.equal(cleared.text, 'Cleared all cookies (3 removed).');
    assert.equal((await srv.call('browser_get_cookies')).text, 'No cookies.');
  });

  test('storage state round trip restores cookies, localStorage and sessionStorage', async () => {
    await srv.call('browser_clear_cookies');
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/set-cookie?name=sid&value=s3cr3t&httponly=1` });
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/storage.html` });
    const seeded = await srv.call('browser_evaluate', {
      expression: 'localStorage.setItem("k", "v1"); localStorage.setItem("json", JSON.stringify({a: 1})); sessionStorage.setItem("s", "v2"); localStorage.length',
    });
    assert.equal(seeded.text, '2');

    const exported = await srv.call('browser_storage_state');
    assert.equal(exported.isError, false, exported.text);
    const state = JSON.parse(exported.text);
    assert.deepEqual(state.cookies, [{ name: 'sid', value: 's3cr3t', domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }]);
    assert.deepEqual(state.origins, [
      {
        origin,
        localStorage: [
          { name: 'k', value: 'v1' },
          { name: 'json', value: '{"a":1}' },
        ],
        sessionStorage: [{ name: 's', value: 'v2' }],
      },
    ]);

    // wipe everything
    await srv.call('browser_clear_cookies');
    const wiped = await srv.call('browser_evaluate', { expression: 'localStorage.clear(); sessionStorage.clear(); localStorage.length + sessionStorage.length' });
    assert.equal(wiped.text, '0');
    assert.equal((await srv.call('browser_get_cookies')).text, 'No cookies.');

    const restored = await srv.call('browser_set_storage_state', { state });
    assert.equal(restored.isError, false, restored.text);
    assert.match(restored.text, /^Cookies: restored 1 of 1\.$/m);
    assert.match(restored.text, new RegExp(`^Storage for ${origin.replace(/\./g, '\\.')}: set 2 localStorage and 1 sessionStorage item\\(s\\)\\.$`, 'm'));
    assert.match(restored.text, /^Note: restored storage is visible to the current page and is lost when this tab navigates or reloads\.$/m);

    const readBack = await srv.call('browser_evaluate', {
      expression: '[localStorage.getItem("k"), localStorage.getItem("json"), sessionStorage.getItem("s"), localStorage.length].join("|")',
    });
    assert.equal(readBack.text, 'v1|{"a":1}|v2|2');
    assert.deepEqual(JSON.parse((await srv.call('browser_get_cookies', { name: 'sid' })).text), state.cookies[0]);
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/echo?after=restore` });
    assert.match(String(fx.requests.filter((r) => r.url === '/echo?after=restore').at(-1)!.headers.cookie), /sid=s3cr3t/);

    // Obscura's legacy export format ([key, value] pairs, snake_case keys), a JSON string, and a foreign origin
    const legacy = {
      cookies: [{ name: 'legacy', value: '1', domain: host, path: '/', http_only: true, same_site: 'Strict', expires: null }],
      origins: [
        { origin: `${origin}/`, localStorage: [['lk', 'lv']], sessionStorage: [['sk', 'sv']] },
        { origin: 'https://other.example', localStorage: [['x', 'y']] },
      ],
    };
    const legacyRes = await srv.call('browser_set_storage_state', { state: JSON.stringify(legacy) });
    assert.equal(legacyRes.isError, false, legacyRes.text);
    assert.match(legacyRes.text, /^Cookies: restored 1 of 1\.$/m);
    assert.match(legacyRes.text, /set 1 localStorage and 1 sessionStorage item\(s\)\./);
    assert.match(
      legacyRes.text,
      new RegExp(`Skipped storage for https://other\\.example \\(1 item\\(s\\)\\): the active tab is on ${origin.replace(/\./g, '\\.')}\\. Navigate the active tab to https://other\\.example`),
    );
    assert.equal((await srv.call('browser_evaluate', { expression: 'localStorage.getItem("lk") + sessionStorage.getItem("sk")' })).text, 'lvsv');
    const legacyCookie = JSON.parse((await srv.call('browser_get_cookies', { name: 'legacy' })).text);
    assert.equal(legacyCookie.httpOnly, true);
    assert.equal(legacyCookie.sameSite, 'Strict');

    const invalid = await srv.call('browser_set_storage_state', {
      state: { cookies: [{ value: 'x' }, { name: 'nodomain', value: '1' }, { name: 'old', value: '1', domain: host, expires: 1000 }] },
    });
    assert.equal(invalid.isError, false, invalid.text);
    assert.match(invalid.text, /Cookies: restored 0 of 3 \(skipped 3\)\./);
    assert.match(invalid.text, /cookie #1 missing name/);
    assert.match(invalid.text, /cookie #2 "nodomain": missing domain/);
    assert.match(invalid.text, /cookie #3 "old": expired/);

    // cookies exported by browser extensions (chrome.cookies format) and null storage values
    const expirationDate = Math.floor(Date.now() / 1000) + 3600 + 0.25;
    const chromeExport = await srv.call('browser_set_storage_state', {
      state: {
        cookies: [
          { name: 'ext1', value: 'a', domain: '.example.com', path: '/', sameSite: 'no_restriction', secure: true, expirationDate, hostOnly: false, session: false },
          { name: 'ext2', value: 'b', domain: 'example.com', path: '/', sameSite: 'unspecified', session: true },
        ],
        origins: [{ origin, localStorage: [{ name: 'nullish', value: null }, { name: 'ok', value: 'yes' }] }],
      },
    });
    assert.equal(chromeExport.isError, false, chromeExport.text);
    assert.match(chromeExport.text, /^Cookies: restored 2 of 2\.$/m);
    assert.match(chromeExport.text, /set 1 localStorage and 0 sessionStorage item\(s\), skipped 1\./);
    const ext1 = JSON.parse((await srv.call('browser_get_cookies', { name: 'ext1' })).text);
    assert.equal(ext1.sameSite, 'None');
    assert.equal(ext1.expires, Math.floor(expirationDate));
    assert.equal(JSON.parse((await srv.call('browser_get_cookies', { name: 'ext2' })).text).expires, -1);
    assert.equal((await srv.call('browser_evaluate', { expression: 'String(localStorage.getItem("nullish"))' })).text, 'null');

    // without a web page in the active tab, storage is skipped with a hint
    await srv.call('browser_navigate', { url: 'about:blank' });
    const blank = await srv.call('browser_set_storage_state', { state: { origins: [{ origin, localStorage: [{ name: 'k', value: 'v' }] }] } });
    assert.equal(blank.isError, false, blank.text);
    assert.match(blank.text, new RegExp(`^Skipped storage for ${origin.replace(/\./g, '\\.')} \\(1 item\\(s\\)\\): the active tab is not on a web page\\. Navigate the active tab to`));

    const empty = await srv.call('browser_set_storage_state', { state: {} });
    assert.equal(empty.isError, true);
    const notJson = await srv.call('browser_set_storage_state', { state: '{nope' });
    assert.equal(notJson.isError, true);
    assert.match(notJson.text, /not valid JSON/);
    await srv.call('browser_clear_cookies');
  });

  test('evaluate: expressions, statements, await, objects, DOM nodes and special values', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const ev = async (expression: string, extra: Record<string, unknown> = {}) => {
      const r = await srv.call('browser_evaluate', { expression, ...extra });
      assert.equal(r.isError, false, `${expression} -> ${r.text}`);
      return r.text;
    };
    assert.equal(await ev('1 + 2'), '3');
    assert.equal(await ev('1.5'), '1.5');
    assert.equal(await ev('"str"'), 'str');
    assert.equal(await ev('true'), 'true');
    assert.equal(await ev('undefined'), 'undefined');
    assert.equal(await ev('null'), 'null');
    assert.equal(await ev('NaN'), 'NaN');
    assert.equal(await ev('const n = 21; n * 2'), '42');
    assert.equal(await ev('let z = 1; return z + 1'), '2');
    assert.equal(await ev('await Promise.resolve(7)'), '7');
    assert.equal(await ev('Promise.resolve("later")'), 'later');
    assert.deepEqual(JSON.parse(await ev('const r = await fetch("/api/data")\nconst j = await r.json()\nj.items')), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(JSON.parse(await ev('({a: 1, b: [1, 2], nested: {c: "x"}, d: new Date(0)})')), {
      a: 1,
      b: [1, 2],
      nested: { c: 'x' },
      d: '1970-01-01T00:00:00.000Z',
    });
    assert.deepEqual(JSON.parse(await ev('[1, undefined, null]')), [1, 'undefined', null]);
    assert.equal(await ev('document.querySelector("h1")'), '<h1>Hello Fixture</h1>');
    assert.deepEqual(JSON.parse(await ev('document.querySelectorAll("a.item")')), [
      '<a href="/i/1" class="item">Item One</a>',
      '<a href="/i/2" class="item">Item Two</a>',
    ]);
    assert.match(await ev('Promise.resolve(1)', { await_promise: false }), /^Promise \(not awaited/);
  });

  test('evaluate: object-literal code, compact and valid JSON for large results', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const ev = async (expression: string) => {
      const r = await srv.call('browser_evaluate', { expression });
      assert.equal(r.isError, false, `${expression} -> ${r.text}`);
      return r.text;
    };
    // like a devtools console: braces around an object literal are an object, not a block
    assert.deepEqual(JSON.parse(await ev('{a: 1, b: [1, 2]}')), { a: 1, b: [1, 2] });
    assert.deepEqual(JSON.parse(await ev('{title: document.title}')), { title: 'Fixture Home' });
    assert.deepEqual(JSON.parse(await ev('{t: await Promise.resolve("x")}')), { t: 'x' });
    assert.equal(await ev('{ let x = 40; x + 2 }'), '42', 'a real block still runs as statements');

    // arrays of primitives are packed onto lines instead of one item per line
    const numbers = JSON.parse(await ev('Array.from({length: 450}, (_, i) => i)'));
    assert.equal(numbers.length, 450);
    assert.ok((await ev('Array.from({length: 450}, (_, i) => i)')).split('\n').length < 60);
    // arrays are cut after 500 items
    assert.deepEqual(JSON.parse(await ev('Array.from({length: 1000}, (_, i) => i)')).slice(-2), [499, '[500 more items]']);

    // results over the size budget stay readable JSON without internal markers
    for (const expression of ['Array.from({length: 600}, () => document.body)', 'Array.from({length: 300}, () => Array.from({length: 300}, () => ({a: 1, b: "x"})))']) {
      const big = await ev(expression);
      assert.doesNotMatch(big, /__type/, expression);
      assert.ok(big.length <= 20_100, `${expression}: ${big.length} chars`);
      assert.match(big, /more items/, expression);
      assert.doesNotThrow(() => JSON.parse(big), expression);
    }

    // top-level await anywhere in an expression (V8 reports these with different messages)
    assert.equal(await ev('JSON.stringify(await (await fetch("/api/data")).json())'), '{"items":["alpha","beta","gamma"]}');
    assert.deepEqual(JSON.parse(await ev('[await Promise.resolve(1), await Promise.resolve(2)]')), [1, 2]);
    assert.equal(await ev('const doubled = {v: await Promise.resolve(21)}; doubled.v * 2'), '42');

    // a runtime SyntaxError is reported, and the code is not run a second time
    for (const expression of [
      'window.__evalRuns = (window.__evalRuns || 0) + 1; eval("await 1")',
      'window.__evalRuns = (window.__evalRuns || 0) + 1; eval("return 1")',
      'window.__evalRuns = (window.__evalRuns || 0) + 1; JSON.parse("{") // await',
      // without stack frames the parse check decides
      'Error.stackTraceLimit = 0; window.__evalRuns = (window.__evalRuns || 0) + 1; eval("return 1")',
    ]) {
      const r = await srv.call('browser_evaluate', { expression });
      assert.equal(r.isError, true, expression);
      assert.match(r.text, /^Error: JavaScript error: SyntaxError: /, expression);
      assert.equal(await ev('Error.stackTraceLimit = 10; const runs = window.__evalRuns; delete window.__evalRuns; runs'), '1', expression);
    }
  });

  test('evaluate keeps the value after history.pushState and calls arrow-function results', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    // RQ-6: pushState bumps navSeq but does not replace the document, so the value must still come back,
    // reported as a URL change rather than a lost value / navigation
    const pushed = await srv.call('browser_evaluate', { expression: 'history.pushState({}, "", "/pushed-here"); ({a: 1, b: 2})' });
    assert.equal(pushed.isError, false, pushed.text);
    assert.deepEqual(JSON.parse(pushed.text.split('\n')[0]!), { a: 1, b: 2 });
    assert.match(pushed.text, /URL changed to .*\/pushed-here/);
    assert.doesNotMatch(pushed.text, /no longer available|The page navigated/);

    // RQ-8: an arrow/function expression is called and its value returned, not the string "function ..."
    assert.equal((await srv.call('browser_evaluate', { expression: '() => document.title' })).text, 'Fixture Home');
    assert.equal((await srv.call('browser_evaluate', { expression: '() => 6 * 7' })).text, '42');
  });

  test('evaluate: errors, syntax errors, navigation and timeouts', { skip: FRESH_SERVER_ONLY }, async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const typeError = await srv.call('browser_evaluate', { expression: 'null.x' });
    assert.equal(typeError.isError, true);
    assert.match(typeError.text, /^Error: JavaScript error: TypeError: Cannot read properties of null \(reading 'x'\)$/);
    const thrown = await srv.call('browser_evaluate', { expression: 'throw new Error("boom")' });
    assert.match(thrown.text, /^Error: JavaScript error: Error: boom/);
    assert.doesNotMatch(thrown.text, /eval-remote|obscura/);
    assert.equal((await srv.call('browser_evaluate', { expression: 'throw {code: 42, reason: "nope"}' })).text, 'Error: JavaScript error: {"code":42,"reason":"nope"}');
    assert.equal((await srv.call('browser_evaluate', { expression: 'await Promise.reject("plain")' })).text, 'Error: JavaScript error: plain');
    const rejected = await srv.call('browser_evaluate', { expression: 'await Promise.reject(new Error("nope"))' });
    assert.equal(rejected.isError, true);
    assert.match(rejected.text, /JavaScript error: Error: nope/);
    const syntax = await srv.call('browser_evaluate', { expression: '1 +' });
    assert.equal(syntax.isError, true);
    assert.match(syntax.text, /JavaScript error: SyntaxError: Unexpected end of input/);
    const asyncSyntax = await srv.call('browser_evaluate', { expression: 'await (1 +' });
    assert.equal(asyncSyntax.isError, true);
    assert.match(asyncSyntax.text, /SyntaxError/);

    const nav = await srv.call('browser_evaluate', { expression: 'location.href = "/page2.html"; "ok"' });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /^ok\nThe page navigated to http:\/\/.+\/page2\.html — "Page Two"/);

    let started = Date.now();
    const pending = await srv.call('browser_evaluate', { expression: 'new Promise(r => setTimeout(r, 5000))', timeout: 0.5 });
    assert.equal(pending.isError, true);
    assert.match(pending.text, /did not finish within 0\.5 s \(timeout\): a promise was still pending\. Pass a larger timeout \(up to \d+ s\)/);
    assert.ok(Date.now() - started < 3000, `promise timeout took ${Date.now() - started} ms`);

    started = Date.now();
    const loop = await srv.call('browser_evaluate', { expression: 'while (true) {}', timeout: 1 });
    const loopMs = Date.now() - started;
    assert.equal(loop.isError, true);
    assert.match(loop.text, /did not finish within 1 s/);
    assert.match(loop.text, /Obscura's JS watchdog \(OBSCURA_JS_WATCHDOG_MS=4000\) stops it after 4 s/);
    assert.ok(loopMs < 3900, `sync loop returned after ${loopMs} ms`);
    // the browser recovers once the watchdog has stopped the loop
    assert.equal((await srv.call('browser_evaluate', { expression: 'document.title' })).text, 'Page Two');

    started = Date.now();
    const watchdog = await srv.call('browser_evaluate', { expression: 'for (;;) {}', timeout: 20 });
    assert.equal(watchdog.isError, true);
    assert.match(watchdog.text, /terminated by Obscura's JS watchdog after 4 s/);
    assert.ok(Date.now() - started < 10_000);
    assert.equal((await srv.call('browser_evaluate', { expression: '"alive"' })).text, 'alive');

    // the watchdog also bounds awaited timers, so a longer timeout does not help
    started = Date.now();
    const slowTimer = await srv.call('browser_evaluate', { expression: 'await new Promise(r => setTimeout(r, 6000))', timeout: 20 });
    assert.equal(slowTimer.isError, true);
    assert.match(slowTimer.text, /terminated by Obscura's JS watchdog after 4 s \(OBSCURA_JS_WATCHDOG_MS=4000\) before it finished; the watchdog limit is shorter than the requested 20 s timeout/);
    assert.ok(Date.now() - started < 8_000, `watchdog-limited promise took ${Date.now() - started} ms`);
    assert.equal((await srv.call('browser_evaluate', { expression: 'await new Promise(r => setTimeout(() => r("done"), 300))' })).text, 'done');
  });

  test('console messages: levels, exceptions, timer errors, persistence and clearing', async () => {
    // console output persists per tab across navigations; start from a clean buffer so this test is
    // isolated from earlier tests (against a shared container they run in the same browser).
    await srv.call('browser_close');
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/console.html` });
    let text = '';
    for (let i = 0; i < 30; i++) {
      text = (await srv.call('browser_console_messages')).text;
      if (text.includes('Timer error') && text.includes('fetch done')) break;
      await sleep(100);
    }
    assert.match(text, /^\[log\] hello from page 42/m);
    assert.match(text, /^\[warn\] a warning$/m);
    assert.match(text, /^\[error\] an error happened$/m);
    assert.match(text, /^\[exception\] Uncaught Error: top level boom/m);
    assert.match(text, /^\[info\] fetch done$/m);
    assert.match(text, /^\[error\] Timer error: ReferenceError: undefinedFunctionCall is not defined/m);
    assert.doesNotMatch(text, /obscura:bootstrap|ext:core/);

    const errors = await srv.call('browser_console_messages', { level: 'error' });
    const levels = entryLines(errors.text).map((l) => /^\[(\w+)\]/.exec(l)![1]);
    assert.ok(levels.length >= 3);
    assert.ok(levels.every((l) => l === 'error' || l === 'exception'), levels.join());
    assert.deepEqual(entryLines((await srv.call('browser_console_messages', { level: 'warn' })).text), ['[warn] a warning']);
    const limited = await srv.call('browser_console_messages', { limit: 2 });
    assert.match(limited.text, /^Showing the last 2 of \d+ messages\./);
    assert.equal(entryLines(limited.text).length, 2);

    await srv.call('browser_evaluate', { expression: 'console.debug("from evaluate", {x: 1})' });
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/page2.html` });
    const persisted = await srv.call('browser_console_messages');
    assert.match(persisted.text, /\[warn\] a warning/, 'messages survive navigation');
    assert.match(persisted.text, /^\[debug\] from evaluate/m);

    const cleared = await srv.call('browser_console_messages', { level: 'warn', clear: true });
    assert.match(cleared.text, /\[warn\] a warning\n\(\d+ message\(s\) cleared\)$/);
    assert.equal((await srv.call('browser_console_messages')).text, 'No console messages.');

    // long output keeps the newest messages and drops the oldest
    await srv.call('browser_evaluate', { expression: 'for (let i = 0; i < 100; i++) console.log("flood " + i + " " + "x".repeat(1000)); "ok"' });
    const flood = await srv.call('browser_console_messages');
    assert.match(flood.text, /^\[log\] flood 99 x+$/m, 'newest message is shown');
    assert.doesNotMatch(flood.text, /^\[log\] flood 0 /m, 'oldest message is dropped');
    assert.match(flood.text, /^Showing the last \d+ of 100 messages/);
    assert.ok(flood.text.length <= 20_100, `${flood.text.length} chars`);
    await srv.call('browser_console_messages', { clear: true });
  });

  test('network requests: resources, status, 404 filter, type filter, reset on navigation', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/network.html` });
    await sleep(300);
    const all = await srv.call('browser_network_requests');
    const lines = entryLines(all.text);
    const esc = fx.baseUrl.replace(/\./g, '\\.');
    assert.match(lines[0]!, new RegExp(`^\\[200\\] GET ${esc}/network\\.html \\(Document, \\d+ B(, \\d+ ms)?\\)$`));
    assert.ok(lines.some((l) => new RegExp(`^\\[200\\] GET ${esc}/network-script\\.js \\(Script, `).test(l)), all.text);
    assert.ok(lines.some((l) => /network-style\.css \(Stylesheet, /.test(l)), all.text);
    assert.ok(lines.some((l) => /^\[404\] GET .*\/status\/404\?img=1 \(Image, /.test(l)), all.text);
    assert.match(all.text, /stealth mode is on: fetch\/XHR requests made by page scripts are not reported/);

    assert.deepEqual(
      entryLines((await srv.call('browser_network_requests', { failed_only: true })).text).map((l) => l.replace(/ \(.*$/, '')),
      [`[404] GET ${fx.baseUrl}/status/404?img=1`],
    );
    assert.equal(entryLines((await srv.call('browser_network_requests', { resource_type: 'script' })).text).length, 1);
    assert.match(entryLines((await srv.call('browser_network_requests', { filter: 'NETWORK-STYLE' })).text)[0]!, /network-style\.css/);
    const limited = await srv.call('browser_network_requests', { limit: 1 });
    assert.match(limited.text, /^Showing the last 1 of 4 requests\./);
    const noFetch = await srv.call('browser_network_requests', { resource_type: 'Fetch' });
    assert.match(noFetch.text, /^No network requests match the filters \(4 recorded for the current page\)\./);

    await srv.call('browser_navigate', { url: `${fx.baseUrl}/page2.html` });
    const reset = entryLines((await srv.call('browser_network_requests')).text);
    assert.equal(reset.length, 1);
    assert.match(reset[0]!, /page2\.html \(Document/);
  });

  test('pdf returns an embedded PDF resource and validates margins', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const r = await srv.call('browser_pdf');
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, new RegExp(`^PDF of http://.+/index\\.html — "Fixture Home" \\(\\d+ page\\(s\\), \\d+ KB, 8\\.5x11 in\\) attached as obscura://capture/${escapeRe(host)}\\.pdf$`));
    const resource = r.raw.content.find((c: any) => c.type === 'resource').resource;
    assert.equal(resource.mimeType, 'application/pdf');
    assert.equal(resource.uri, `obscura://capture/${host}.pdf`);
    assert.equal(Buffer.from(resource.blob, 'base64').subarray(0, 5).toString('latin1'), '%PDF-');

    const landscape = await srv.call('browser_pdf', { landscape: true, print_background: true, scale: 0.5, margin_top: 0 });
    assert.equal(landscape.isError, false, landscape.text);
    assert.match(landscape.text, /11x8\.5 in, landscape\)/);

    const badMargins = await srv.call('browser_pdf', { paper_width: 2, margin_left: 1, margin_right: 1 });
    assert.equal(badMargins.isError, true);
    assert.match(badMargins.text, /margin_left \+ margin_right \(2 in\) must be less than the page width \(2 in\)/);
    const badScale = await srv.call('browser_pdf', { scale: 3 });
    assert.equal(badScale.isError, true);
  });

  test('set_viewport changes innerWidth/innerHeight and screenshot size', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const r = await srv.call('browser_set_viewport', { width: 800, height: 600 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^Viewport of tab-\d+ set to 800x600\.$/);
    assert.equal((await srv.call('browser_evaluate', { expression: 'innerWidth + "x" + innerHeight' })).text, '800x600');
    const shot = await srv.call('browser_screenshot');
    const png = Buffer.from(shot.images[0]!.data, 'base64');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [800, 600]);

    await srv.call('browser_navigate', { url: `${fx.baseUrl}/page2.html` });
    assert.equal((await srv.call('browser_evaluate', { expression: 'innerWidth + "x" + innerHeight' })).text, '800x600', 'size survives navigation');

    const tooSmall = await srv.call('browser_set_viewport', { width: 50, height: 600 });
    assert.equal(tooSmall.isError, true);
    // Obscura cannot capture more than 16 megapixels, so a huge viewport comes with a warning
    const huge = await srv.call('browser_set_viewport', { width: 7680, height: 4320 });
    assert.equal(huge.isError, false, huge.text);
    assert.match(huge.text, /16 megapixels/);
    assert.equal((await srv.call('browser_screenshot')).isError, true);
    await srv.call('browser_set_viewport', { width: 1280, height: 720 });
  });
});

describe('second server: stealth mode off, JS watchdog disabled, short tool timeout', { skip: process.env.MCP_URL ? 'needs its own server with custom settings (not available with MCP_URL)' : false }, () => {
  let fx: FixtureServer;
  let srv: TestServer;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer({ OBSCURA_STEALTH: 'false', OBSCURA_JS_WATCHDOG_MS: '0', TOOL_TIMEOUT_MS: '8000' });
  });
  after(async () => {
    await srv?.stop();
    await fx?.close();
  });

  test('script fetch requests are listed with type Fetch', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/network.html` });
    await srv.call('browser_evaluate', { expression: 'document.getElementById("load").click()' });
    for (let i = 0; i < 30; i++) {
      if ((await srv.call('browser_evaluate', { expression: 'document.getElementById("out").textContent' })).text === 'items:3') break;
      await sleep(100);
    }
    let fetches: string[] = [];
    for (let i = 0; i < 30 && fetches.length < 3; i++) {
      fetches = entryLines((await srv.call('browser_network_requests', { resource_type: 'fetch' })).text);
      await sleep(100);
    }
    assert.ok(fetches.some((l) => /^\[200\] GET .*\/api\/data\?from=inline \(Fetch, \d+ B/.test(l)), fetches.join('\n'));
    assert.ok(fetches.some((l) => /^\[404\] GET .*\/status\/404\?from=inline \(Fetch/.test(l)), fetches.join('\n'));
    assert.ok(fetches.some((l) => /\/api\/data\?from=button \(Fetch/.test(l)), fetches.join('\n'));

    const failed = entryLines((await srv.call('browser_network_requests', { failed_only: true })).text);
    assert.equal(failed.length, 2, failed.join('\n'));
    const all = await srv.call('browser_network_requests');
    assert.doesNotMatch(all.text, /stealth mode/);
  });

  test('evaluate timeouts stay below TOOL_TIMEOUT_MS so the call ends with its own error', async () => {
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
    const started = Date.now();
    const slow = await srv.call('browser_evaluate', { expression: 'await new Promise(r => setTimeout(r, 12000))', timeout: 60 });
    const ms = Date.now() - started;
    assert.equal(slow.isError, true);
    // Obscura normally reports the pending promise at 5 s; under heavy load our own 2 s grace can expire first.
    // Either way the call must end with the script-timeout error before the 8 s tool limit.
    assert.match(slow.text, /did not finish within 5 s \(timeout[;)].*TOOL_TIMEOUT_MS=8000/);
    assert.doesNotMatch(slow.text, /browser_evaluate did not finish within 8 s/);
    assert.ok(ms < 7_900, `took ${ms} ms`);
    assert.equal((await srv.call('browser_evaluate', { expression: '"after"' })).text, 'after');
  });
});
