import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFakeLlm, type FakeLlm, type FakeRequest, type FakeTurn } from '../helpers/fake-llm.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';
import { accountPage, signIn, type FixtureSignIn } from '../helpers/sign-in.ts';

/**
 * Snapshots (saved sign-ins) end to end, on the fixture site's form sign-in (a server-issued HttpOnly
 * session cookie plus a localStorage profile): the host tools, the files they write, encryption at
 * rest, and sub-agents that start signed in or save a sign-in. The host-tool suite also runs against
 * MCP_URL (unique names, deleted at the end); suites that need their own server, its files or a model
 * endpoint are skipped there.
 */
const OWN = process.env.MCP_URL ? 'needs its own server (snapshot files, keys or a model endpoint)' : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const authHeaders = (): Record<string, string> => (process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {});

async function getJson(srv: TestServer, route: string): Promise<any> {
  const res = await fetch(`${srv.baseUrl}${route}`, { headers: authHeaders() });
  assert.equal(res.status, 200, route);
  return res.json();
}

/** Delete a snapshot the way the dashboard page does (its CSRF headers included). */
async function dashboardDelete(srv: TestServer, name: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${srv.baseUrl}/api/snapshots/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { 'X-SBM-Request': '1', Origin: new URL(srv.baseUrl).origin, 'Sec-Fetch-Site': 'same-origin', ...authHeaders() },
  });
  return { status: res.status, body: await res.json() };
}

/** Kill one Obscura engine and wait until the server has started a new one. */
async function killEngine(srv: TestServer, which: 'obscura' | 'obscuraIsolated'): Promise<void> {
  const pid = (await getJson(srv, '/healthz'))[which]?.pid;
  assert.ok(pid, `${which} runs`);
  process.kill(pid, 'SIGKILL');
  const deadline = Date.now() + 30_000;
  for (;;) {
    const h = await fetch(`${srv.baseUrl}/healthz`)
      .then((r) => r.json())
      .catch(() => ({}));
    if (h.ok && h[which]?.pid && h[which].pid !== pid) return;
    if (Date.now() > deadline) throw new Error(`${which} did not restart`);
    await sleep(250);
  }
}

function entry(list: { raw: any }, name: string): any {
  return list.raw.structuredContent.snapshots.find((s: any) => s.name === name);
}

describe('snapshots (host tools)', () => {
  let srv: TestServer;
  let fx: FixtureServer;
  let host: string;
  let origin: string;
  const id = Date.now().toString(36).slice(-6);
  const shop = `shop-${id}`;
  const www = `www-${id}`;
  let alice: FixtureSignIn;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
    host = new URL(fx.baseUrl).hostname;
    origin = new URL(fx.baseUrl).origin;
  });
  after(async () => {
    // a shared server (MCP_URL) keeps running: leave no snapshot and no sign-in behind
    for (const name of [shop, www]) await srv?.call('snapshot_delete', { name }).catch(() => undefined);
    await srv?.call('browser_clear_cookies').catch(() => undefined);
    await srv?.stop();
    await fx?.close();
  });

  test('the snapshot tools have their own group, and the instructions tell them apart from browser_snapshot', async () => {
    const { tools } = await srv.client.listTools();
    for (const name of ['snapshot_list', 'snapshot_save', 'snapshot_describe', 'snapshot_load', 'snapshot_delete']) {
      const tool = tools.find((t) => t.name === name) as any;
      assert.ok(tool, `${name} is listed`);
      assert.equal(tool._meta?.['stealth-web-search/group'], 'snapshots', name);
    }
    const byName = (n: string) => tools.find((t) => t.name === n) as any;
    assert.equal(byName('snapshot_list').annotations.readOnlyHint, true);
    assert.equal(byName('snapshot_load').annotations.destructiveHint, true, 'loading replaces cookies');
    assert.equal(byName('snapshot_delete').annotations.destructiveHint, true);
    assert.match(byName('snapshot_delete').description, /Only call this when your user explicitly asked/);
    assert.match(byName('snapshot_save').description, /not page text: that is browser_snapshot/);
    const instructions = srv.client.getInstructions() ?? '';
    assert.match(instructions, /Snapshots are saved sign-ins .*not page snapshots \(browser_snapshot reads the page\)/);
    assert.match(instructions, /Delete a snapshot only when your user asks/);
    const list = await srv.call('snapshot_list');
    assert.equal(list.isError, false, list.text);
    assert.ok(Array.isArray(list.raw.structuredContent.snapshots));
  });

  test('save a sign-in, list it, and load it back after signing out: the cookie and the site storage return', async () => {
    alice = await signIn(srv, fx, 'alice');
    const noDescription = await srv.call('snapshot_save', { name: shop });
    assert.equal(noDescription.isError, true);
    assert.match(noDescription.text, /does not exist yet: give a description/);

    // the name is normalized; the domain filter defaults to the active tab's site
    const saved = await srv.call('snapshot_save', { name: `  Shop ${id.toUpperCase()} `, description: 'Fixture shop — alice' });
    assert.equal(saved.isError, false, saved.text);
    assert.match(
      saved.text,
      new RegExp(`^Created snapshot "${shop}" \\(v1, "Fixture shop — alice"\\): 1 cookie for ${esc(host)}, and the site storage of ${esc(origin)}\\. It is loaded in this browser\\.`),
    );
    assert.match(saved.text, new RegExp(`agent_run with \\{"snapshot": "${shop}"\\}`));
    assert.deepEqual(saved.raw.structuredContent, {
      action: 'created',
      snapshot: { name: shop, version: 1, description: 'Fixture shop — alice', domains: [host], cookie_count: 1, cookie_domains: [host], origins: [origin] },
    });

    // the storage seed brings the profile back on every page load (Obscura alone loses it on navigation)
    assert.deepEqual(await accountPage(srv, fx), { who: 'Signed in as alice', profile: 'profile: restored' });

    const list = await srv.call('snapshot_list');
    assert.match(
      list.text,
      new RegExp(`^- ${shop} — Fixture shop — alice · 1 cookie for ${esc(host)} · storage for 1 site · v1, updated just now by integration-test[^·]* · loaded in: this browser \\(active\\)$`, 'm'),
    );
    assert.match(list.text, /Use one: snapshot_load \{"name": ".+"\} signs your browser in; agent_run \{"snapshot": ".+", …\} starts a sub-agent signed in\./);
    const e = entry(list, shop);
    assert.equal(e.cookie_count, 1);
    assert.equal(e.session_cookie_count, 1);
    assert.equal(e.expired_count, 0);
    assert.deepEqual(e.cookie_domains, [host]);
    assert.deepEqual(e.origins, [{ origin, local_storage: 1, session_storage: 0 }]);
    assert.deepEqual(e.loaded_in, ['main']);
    assert.equal(e.active_in, undefined, 'the tool result says active_here instead');
    assert.ok(list.raw.structuredContent.loaded_here.includes(shop));
    assert.equal(list.raw.structuredContent.active_here, shop);
    const shown = JSON.stringify(list.raw);
    for (const secret of [alice.token, alice.profile, '\\"session\\"']) assert.ok(!shown.includes(secret), `${secret} in snapshot_list`);

    // sign out, then load it back
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/logout` });
    assert.equal((await accountPage(srv, fx)).who, 'Signed out');
    const loaded = await srv.call('snapshot_load', { name: shop.toUpperCase() });
    assert.equal(loaded.isError, false, loaded.text);
    assert.match(loaded.text, new RegExp(`^Loaded snapshot "${shop}" \\(v1, "Fixture shop — alice"\\) into this browser: restored 1 of 1 cookies for ${esc(host)}\\.$`, 'm'));
    assert.match(loaded.text, new RegExp(`Site storage of ${esc(origin)} is restored on every page load \\(the open page has it now\\)\\.`));
    assert.deepEqual(loaded.raw.structuredContent, { name: shop, version: 1, restored: 1, total: 1, expired: {}, refused: {}, storage_origins: [origin] });
    assert.deepEqual(await accountPage(srv, fx), { who: 'Signed in as alice', profile: 'profile: restored' });
    const sent = fx.requests.filter((r) => r.url === '/account').at(-1)!;
    assert.match(String(sent.headers.cookie), new RegExp(`session=${alice.token}`), 'the saved cookie is sent to the site');
  });

  test('describe changes only the description', async () => {
    const res = await srv.call('snapshot_describe', { name: shop, description: 'Fixture shop — alice (test account)' });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.text, `Snapshot "${shop}" (v1) is now described as "Fixture shop — alice (test account)".`);
    assert.deepEqual(res.raw.structuredContent, { name: shop, version: 1, description: 'Fixture shop — alice (test account)' });
    const e = entry(await srv.call('snapshot_list'), shop);
    assert.equal(e.description, 'Fixture shop — alice (test account)');
    assert.equal(e.version, 1);
    assert.deepEqual(e.loaded_in, ['main'], 'still loaded as before');
  });

  test("loading replaces the browser's cookies for the snapshot's sites only; other sites keep theirs", async () => {
    await signIn(srv, fx, 'bob');
    await srv.call('browser_set_cookie', { name: 'extra', value: 'on-the-site', url: fx.baseUrl });
    const other = await srv.call('browser_set_cookie', { name: 'keep', value: 'other-site', domain: 'other.example' });
    assert.equal(other.isError, false, other.text);
    const loaded = await srv.call('snapshot_load', { name: shop });
    assert.equal(loaded.isError, false, loaded.text);
    assert.equal((await accountPage(srv, fx)).who, 'Signed in as alice', "bob's session was replaced, not mixed in");
    const cookies = await srv.call('browser_get_cookies');
    assert.doesNotMatch(cookies.text, /"extra"/, 'cookies of the snapshot site that it does not hold are removed');
    assert.match(cookies.text, /"name":"keep","value":"other-site","domain":"other\.example"/);
  });

  test('saving again refreshes the loaded snapshot; a capture without sign-in cookies or of every site is refused', async () => {
    const refreshed = await srv.call('snapshot_save', { name: shop });
    assert.equal(refreshed.isError, false, refreshed.text);
    assert.match(refreshed.text, new RegExp(`^Refreshed snapshot "${shop}" \\(v2, "Fixture shop — alice \\(test account\\)"\\)`));
    assert.equal(refreshed.raw.structuredContent.action, 'refreshed');

    await srv.call('browser_navigate', { url: `${fx.baseUrl}/logout` });
    const empty = await srv.call('snapshot_save', { name: shop });
    assert.equal(empty.isError, true);
    assert.equal(empty.text, `Error: This browser has no sign-in cookies for ${host}; snapshot not changed.`);
    const replaceEmpty = await srv.call('snapshot_save', { name: shop, replace: true });
    assert.equal(replaceEmpty.isError, true, 'replace does not save an empty sign-in either');
    assert.equal(entry(await srv.call('snapshot_list'), shop).version, 2);

    const nothing = await srv.call('snapshot_save', { name: `none-${id}`, description: 'Nothing', domains: ['nothing.example'] });
    assert.equal(nothing.isError, true);
    assert.equal(nothing.text, 'Error: This browser has no sign-in cookies for nothing.example; no snapshot was saved.');
    assert.equal(entry(await srv.call('snapshot_list'), `none-${id}`), undefined);

    // a filter of every site would also save the sign-in the loaded snapshot put into this browser
    const all = await srv.call('snapshot_save', { name: `all-${id}`, description: 'Everything', domains: ['*'] });
    assert.equal(all.isError, true);
    assert.match(all.text, new RegExp(`saves every cookie of this browser \\(domains \\["\\*"\\]\\), and snapshot "${shop}" is also loaded here.*Create it with domains, or load it again first\\.`));
  });

  test('a www filter keeps the parent-domain cookies a browser would send to that site', async () => {
    const set = async (name: string, domain: string) => {
      const res = await srv.call('browser_set_cookie', { name, value: `${name}-value`, domain });
      assert.equal(res.isError, false, res.text);
    };
    await set('parent', '.example.test');
    await set('own', 'www.example.test');
    await set('sibling', 'shop.example.test');
    await set('lookalike', 'evil-example.test');
    const saved = await srv.call('snapshot_save', { name: www, description: 'Example — www', domains: ['https://WWW.Example.test/path'] });
    assert.equal(saved.isError, false, saved.text);
    const s = saved.raw.structuredContent.snapshot;
    assert.deepEqual(s.domains, ['www.example.test']);
    assert.equal(s.cookie_count, 2);
    assert.deepEqual(s.cookie_domains, ['example.test', 'www.example.test']);
    assert.deepEqual(s.origins, [], 'the active tab is on another site: no site storage');

    await srv.call('browser_clear_cookies');
    const loaded = await srv.call('snapshot_load', { name: www });
    assert.match(loaded.text, /restored 2 of 2 cookies for example\.test, www\.example\.test\./);
    const names = JSON.parse(`[${(await srv.call('browser_get_cookies')).text.split('\n').join(',')}]`).map((c: any) => `${c.name}@${c.domain}`);
    assert.deepEqual(names.sort(), ['own@www.example.test', 'parent@example.test']);
  });

  test('bad and unknown names are refused by every snapshot tool', async () => {
    const bad = ['..', '/', 'a/b', '%2f', '../etc/passwd', '.hidden', '-x', 'x'.repeat(65), 'a\u0000b', 'naïve'];
    for (const name of bad) {
      for (const [tool, extra] of [
        ['snapshot_load', {}],
        ['snapshot_delete', {}],
        ['snapshot_describe', { description: 'x' }],
        ['snapshot_save', { description: 'x' }],
      ] as const) {
        const res = await srv.call(tool, { name, ...extra });
        assert.equal(res.isError, true, `${tool} ${JSON.stringify(name)}`);
        assert.match(res.text, /Invalid snapshot name/, `${tool} ${JSON.stringify(name)}`);
      }
    }
    const empty = await srv.call('snapshot_load', { name: '' }).catch((err) => ({ isError: true, text: String(err) }));
    assert.equal(empty.isError, true);
    for (const [tool, extra] of [
      ['snapshot_load', {}],
      ['snapshot_describe', { description: 'x' }],
      ['snapshot_delete', {}],
    ] as const) {
      const res = await srv.call(tool, { name: `nope-${id}`, ...extra });
      assert.equal(res.isError, true, tool);
      assert.match(res.text, new RegExp(`No snapshot named "nope-${id}"\\. Saved snapshots: .*${shop}.* \\(see snapshot_list\\)\\.`), tool);
    }
  });

  test('a lost browser connection drops the loaded snapshots: the host is told, and saving then needs replace', { skip: OWN }, async () => {
    const loaded = await srv.call('snapshot_load', { name: shop });
    assert.equal(loaded.isError, false, loaded.text);
    await killEngine(srv, 'obscura');
    const notice = await srv.call('browser_tab_list');
    assert.match(notice.text, /The browser connection was lost \(.*\) and has been re-established;/);
    assert.match(notice.text, new RegExp(`The snapshots "${shop}", "${www}" loaded in this browser were lost; load them again with snapshot_load\\.`));
    const list = await srv.call('snapshot_list');
    assert.deepEqual(list.raw.structuredContent.loaded_here, []);
    assert.equal(list.raw.structuredContent.active_here, null);
    assert.deepEqual(entry(list, shop).loaded_in, []);

    await signIn(srv, fx, 'carol');
    const refused = await srv.call('snapshot_save', { name: shop });
    assert.equal(refused.isError, true);
    assert.equal(
      refused.text,
      `Error: Snapshot "${shop}" is not loaded in this browser. If you signed in by hand to the account this snapshot is for, call again with replace: true to overwrite it; otherwise load it first with snapshot_load, or save under a new name.`,
    );
    const replaced = await srv.call('snapshot_save', { name: shop, replace: true });
    assert.equal(replaced.isError, false, replaced.text);
    assert.match(replaced.text, new RegExp(`^Replaced snapshot "${shop}" \\(v3, `));
    assert.deepEqual(replaced.raw.structuredContent.snapshot.domains, [host], 'the stored domain filter is kept');
    assert.equal((await srv.call('snapshot_list')).raw.structuredContent.active_here, shop);
  });

  test('delete removes a snapshot for good and takes its site storage out of the browser; a plain save never brings it back', async () => {
    const loaded = await srv.call('snapshot_load', { name: shop });
    assert.equal(loaded.isError, false, loaded.text);
    const before = await accountPage(srv, fx);
    assert.match(before.who, /^Signed in as /);
    assert.equal(before.profile, 'profile: restored');

    const deleted = await srv.call('snapshot_delete', { name: shop });
    assert.equal(deleted.isError, false, deleted.text);
    assert.equal(
      deleted.text,
      `Deleted snapshot "${shop}". Cookies it already put into a browser stay there until cleared (browser_clear_cookies). It was loaded in: this browser.`,
    );
    assert.deepEqual(deleted.raw.structuredContent, { deleted: shop, loaded_in: ['main'] });
    const after = await accountPage(srv, fx);
    assert.equal(after.who, before.who, 'its cookie stays in the browser');
    assert.equal(after.profile, 'profile: none', 'its site storage is no longer restored');

    const load = await srv.call('snapshot_load', { name: shop });
    assert.equal(load.isError, true);
    assert.match(load.text, new RegExp(`No snapshot named "${shop}"`));
    const again = await srv.call('snapshot_delete', { name: shop });
    assert.equal(again.isError, true);
    const save = await srv.call('snapshot_save', { name: shop });
    assert.equal(save.isError, true);
    assert.match(save.text, /does not exist yet: give a description/);
    assert.equal(entry(await srv.call('snapshot_list'), shop), undefined);
  });
});

describe('snapshot files and encryption at rest', { skip: OWN }, () => {
  let fx: FixtureServer;
  before(async () => {
    fx = await startFixtureServer();
  });
  after(async () => {
    await fx?.close();
  });

  test('files are 0600 in a 0700 folder, the metadata holds no cookie or storage value, and incomplete entries can be deleted', { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbm-snapfiles-'));
    chmodSync(dir, 0o755); // an existing folder others can read is restricted at startup
    const srv = await startTestServer({ SNAPSHOTS_DIR: dir });
    try {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      const s = await signIn(srv, fx, 'erin');
      const saved = await srv.call('snapshot_save', { name: 'files', description: 'Fixture shop — erin' });
      assert.equal(saved.isError, false, saved.text);
      assert.deepEqual(readdirSync(dir).sort(), ['files.json', 'files.state']);
      for (const f of readdirSync(dir)) assert.equal(statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
      const meta = readFileSync(path.join(dir, 'files.json'), 'utf8');
      for (const secret of [s.token, s.profile, '"session"', 'profile']) assert.ok(!meta.includes(secret), `${secret} in the metadata`);
      assert.match(readFileSync(path.join(dir, 'files.state'), 'utf8'), new RegExp(s.token), 'without SNAPSHOTS_KEY the state is plain (owner-only)');
      const api = await getJson(srv, '/api/snapshots');
      assert.equal(api.dir, dir);
      assert.equal(api.encrypted, false);
      assert.equal(api.unencrypted_count, 1);

      // a saved state without metadata is listed, blocks its name, and can be deleted
      writeFileSync(path.join(dir, 'orphan.state'), '{"version":1,"cookies":[],"origins":[]}\n', { mode: 0o600 });
      const list = await srv.call('snapshot_list');
      assert.match(list.text, /^- orphan — incomplete: a saved sign-in without valid metadata; it cannot be loaded\. Ask your user whether to delete it \(snapshot_delete\)\.$/m);
      const create = await srv.call('snapshot_save', { name: 'orphan', description: 'x' });
      assert.equal(create.isError, true);
      assert.match(create.text, /incomplete snapshot named "orphan"/);
      const load = await srv.call('snapshot_load', { name: 'orphan' });
      assert.equal(load.isError, true);
      const del = await srv.call('snapshot_delete', { name: 'orphan' });
      assert.equal(del.isError, false, del.text);
      assert.equal(existsSync(path.join(dir, 'orphan.state')), false);
    } finally {
      await srv.stop();
    }
  });

  test('snapshot code never logs a cookie or storage value, even with LOG_REDACT_SECRETS=false', async () => {
    const srv = await startTestServer({ LOG_REDACT_SECRETS: 'false' });
    try {
      const s = await signIn(srv, fx, 'quinn');
      await sleep(300);
      // with redaction off the sign-in itself may be logged; everything after this point is snapshot work
      const mark = readFileSync(path.join(srv.logDir!, 'current.log'), 'utf8').length;
      assert.equal((await srv.call('snapshot_save', { name: 'quiet', description: 'Fixture shop — quinn' })).isError, false);
      await srv.call('snapshot_list');
      await srv.call('browser_navigate', { url: `${fx.baseUrl}/logout` });
      assert.equal((await srv.call('snapshot_load', { name: 'quiet' })).isError, false);
      assert.deepEqual(await accountPage(srv, fx), { who: 'Signed in as quinn', profile: 'profile: restored' });
      assert.equal((await srv.call('snapshot_save', { name: 'quiet' })).isError, false);
      assert.equal((await srv.call('snapshot_delete', { name: 'quiet' })).isError, false);
      await sleep(300);
      const logged = readFileSync(path.join(srv.logDir!, 'current.log'), 'utf8').slice(mark);
      assert.ok(logged.includes('snapshot quiet created'), 'the snapshot work is in this part of the log');
      assert.ok(!logged.includes(s.token), 'the session cookie value was logged');
      assert.ok(!logged.includes(s.profile), 'the site storage value was logged');
      assert.ok(!logged.includes('hasOwnProperty.call(seed'), 'the storage seed script was logged');
    } finally {
      await srv.stop();
    }
  });

  test('with SNAPSHOTS_KEY the state is encrypted; another key or none cannot read it; older plain files are encrypted at startup', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbm-snapkey-'));
    let srv = await startTestServer({ SNAPSHOTS_DIR: dir });
    let s: FixtureSignIn;
    try {
      s = await signIn(srv, fx, 'frank');
      assert.equal((await srv.call('snapshot_save', { name: 'plain', description: 'Fixture shop — frank' })).isError, false);
      assert.match(readFileSync(path.join(dir, 'plain.state'), 'utf8'), new RegExp(s.token));
    } finally {
      await srv.stop();
    }

    srv = await startTestServer({ SNAPSHOTS_DIR: dir, SNAPSHOTS_KEY: 'integration-key-one' });
    try {
      // encrypted in the background at startup
      for (let i = 0; i < 50 && !readFileSync(path.join(dir, 'plain.state'), 'utf8').includes('aes-256-gcm'); i++) await sleep(100);
      const state = readFileSync(path.join(dir, 'plain.state'), 'utf8');
      assert.equal(JSON.parse(state).alg, 'aes-256-gcm');
      for (const secret of [s.token, s.profile]) assert.ok(!state.includes(secret));
      assert.equal(JSON.parse(readFileSync(path.join(dir, 'plain.json'), 'utf8')).encrypted, true);
      const loaded = await srv.call('snapshot_load', { name: 'plain' });
      assert.equal(loaded.isError, false, loaded.text);
      assert.equal((await accountPage(srv, fx)).who, 'Signed in as frank');
      // a new save is encrypted too
      const again = await signIn(srv, fx, 'gina');
      assert.equal((await srv.call('snapshot_save', { name: 'keyed', description: 'Fixture shop — gina' })).isError, false);
      assert.ok(!readFileSync(path.join(dir, 'keyed.state'), 'utf8').includes(again.token));
      const api = await getJson(srv, '/api/snapshots');
      assert.equal(api.encrypted, true);
      assert.equal(api.unencrypted_count, 0);
      const logs = readFileSync(path.join(srv.logDir!, 'current.log'), 'utf8');
      assert.match(logs, /encrypted 1 saved snapshot\(s\) with SNAPSHOTS_KEY/);
      assert.ok(srv.logs().some((l) => l.component === 'main' && l.snapshots?.key === 'configured'), 'the startup log says a key is configured');
      assert.ok(!logs.includes('integration-key-one'), 'the key is never logged');
    } finally {
      await srv.stop();
    }

    for (const env of [{ SNAPSHOTS_KEY: 'integration-key-two' }, {}] as Array<Record<string, string>>) {
      srv = await startTestServer({ SNAPSHOTS_DIR: dir, ...env });
      try {
        const bad = await srv.call('snapshot_load', { name: 'plain' });
        assert.equal(bad.isError, true);
        assert.equal(bad.text, 'Error: cannot decrypt snapshot "plain": SNAPSHOTS_KEY is missing or differs from the one used to save it');
        // still listed (its metadata is not secret), never reported as missing
        assert.ok(entry(await srv.call('snapshot_list'), 'plain'));
      } finally {
        await srv.stop();
      }
    }
  });
});

type Policy = (req: FakeRequest) => FakeTurn | Promise<FakeTurn>;
const policies = new Map<string, Policy>();

function dispatch(req: FakeRequest): FakeTurn | Promise<FakeTurn> {
  const task = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  for (const [marker, policy] of policies) if (task.includes(marker)) return policy(req);
  return { content: 'no policy for this task' };
}

function call(name: string, args: Record<string, unknown>): FakeTurn {
  return { reasoning: `I will call ${name}.`, toolCalls: [{ name, arguments: args }] };
}

/** A promise with its resolve function, to hold a scripted agent at a step until the test is ready. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('snapshots and sub-agents (scripted model)', { skip: OWN }, () => {
  let srv: TestServer;
  let fx: FixtureServer;
  let llm: FakeLlm;
  let host: string;
  let origin: string;
  let dir: string;
  const runIds: string[] = [];

  before(async () => {
    fx = await startFixtureServer();
    llm = await startFakeLlm(dispatch);
    dir = mkdtempSync(path.join(tmpdir(), 'sbm-snapagents-'));
    srv = await startTestServer({
      AGENT_LLM_URL: llm.url,
      AGENT_LLM_MODEL: 'fake-model',
      AGENT_WAIT_SECONDS: '60',
      AGENT_MAX_STEPS: '20',
      SNAPSHOTS_DIR: dir,
      SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-scripts-')),
    });
    host = new URL(fx.baseUrl).hostname;
    origin = new URL(fx.baseUrl).origin;
    // the host signs in once and saves it; then its own browser signs out
    await signIn(srv, fx, 'alice');
    const saved = await srv.call('snapshot_save', { name: 'shop', description: 'Fixture shop — alice' });
    assert.equal(saved.isError, false, saved.text);
    await srv.call('browser_navigate', { url: `${fx.baseUrl}/logout` });
    await srv.call('browser_clear_cookies');
  });
  after(async () => {
    await srv?.stop();
    await llm?.close();
    await fx?.close();
  });

  const requestsOf = (marker: string) => llm.requests.filter((r) => String(r.messages[1]?.content).includes(marker));

  test('agent_run with a snapshot starts signed in, without browser_evaluate, and refreshes the snapshot when it succeeds; the main browser is untouched', async () => {
    const unknown = await srv.call('agent_run', { task: 'x', output: 'y', snapshot: 'nope' });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.text, 'Error: No snapshot named "nope". Saved snapshots: shop (see snapshot_list).');
    const invalid = await srv.call('agent_run', { task: 'x', output: 'y', snapshot: '../shop' });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /Invalid snapshot name/);

    const marker = 'MARKER-SNAP-RUN';
    let page = '';
    policies.set(marker, (req) => {
      if (req.step === 1) return call('browser_navigate', { url: `${fx.baseUrl}/account` });
      if (req.step === 2) return call('browser_get_text', { selector: 'body' });
      if (req.step === 3) {
        page = String(req.lastToolResult);
        return call('browser_navigate', { url: `${fx.baseUrl}/set-cookie?name=agent_only&value=from-the-agent` });
      }
      return call('finish', { output: 'signed in as alice' });
    });
    const res = await srv.call('agent_run', { task: `${marker}: open the account page`, output: 'who is signed in', snapshot: ' Shop ' });
    assert.equal(res.isError, false, res.text);
    const s = res.raw.structuredContent;
    runIds.push(s.run_id);
    assert.equal(s.status, 'completed');
    assert.match(page, /Signed in as alice/);
    assert.match(page, /profile: restored/, 'the site storage came with it');
    assert.deepEqual(s.snapshot, { name: 'shop', version: 1 });
    assert.deepEqual(s.snapshot_saved, { name: 'shop', version: 2, action: 'refreshed' });
    assert.match(res.text, /Saved sign-in "shop" was refreshed from the agent's browser \(v2\)\./);
    const fromAgent = fx.requests.filter((r) => r.url === '/account').at(-1)!;
    assert.match(String(fromAgent.headers.cookie), /session=sess-/);

    // what the model was told: the snapshot as quoted data in the user message, and no browser_evaluate
    const first = requestsOf(marker)[0]!;
    const system = String(first.messages[0].content);
    const user = String(first.messages[1].content);
    assert.match(user, new RegExp(`Saved sign-in: "shop" — "Fixture shop — alice" \\(cookies for ${esc(host)}\\)\\. Your browser starts signed in to those sites; check before signing in\\.`));
    assert.match(user, /Never read, copy, output or send cookie or storage values\. While signed in, stay on those sites and the sites the TASK names\./);
    assert.doesNotMatch(system, /Saved sign-in:/, 'the snapshot description is not in the system prompt');
    assert.match(system, /starts with the saved sign-in named in the job below/);
    assert.ok(!first.toolNames.includes('browser_evaluate'), 'page scripts could read the signed-in cookies');
    assert.ok(first.toolNames.includes('save_sign_in'));
    assert.ok(!first.toolNames.some((n) => n.startsWith('snapshot_')), 'sub-agents get no host snapshot tools');

    // the main browser never saw the agent's sign-in or its cookie
    assert.equal((await accountPage(srv, fx)).who, 'Signed out');
    assert.doesNotMatch((await srv.call('browser_get_cookies')).text, /agent_only/);
    const state = await getJson(srv, '/api/state');
    assert.equal(state.browsers.find((b: any) => b.id === `agent-${s.run_id}`)?.status, 'closed');
    const list = await srv.call('snapshot_list');
    assert.match(list.text, new RegExp(`^- shop — Fixture shop — alice · 2 cookies for ${esc(host)} · storage for 1 site · v2, updated just now by sub-agent run ${s.run_id}`, 'm'));
    assert.deepEqual(entry(list, 'shop').updated_by, { run_id: s.run_id });
  });

  test("the host's save after a sub-agent refreshed the snapshot is a version conflict; replace overwrites it", async () => {
    await signIn(srv, fx, 'alice');
    const conflict = await srv.call('snapshot_save', { name: 'shop' });
    assert.equal(conflict.isError, true);
    assert.match(conflict.text, new RegExp(`^Error: Snapshot "shop" changed after this browser loaded it: sub-agent run ${runIds[0]} saved v2 after this browser loaded v1\\. .*replace: true`));
    const replaced = await srv.call('snapshot_save', { name: 'shop', replace: true });
    assert.equal(replaced.isError, false, replaced.text);
    assert.match(replaced.text, /^Replaced snapshot "shop" \(v3, /);
  });

  test('the end-of-run refresh is skipped when another browser saved a newer version or the agent signed out, and never runs after a failed job', async () => {
    // another browser (the host's) saves while the job runs
    const reached = gate();
    const release = gate();
    policies.set('MARKER-SKIP-NEWER', async (req) => {
      if (req.step === 1) return call('browser_navigate', { url: `${fx.baseUrl}/account` });
      reached.open();
      await release.promise;
      return call('finish', { output: 'done' });
    });
    const started = await srv.call('agent_run', { task: 'MARKER-SKIP-NEWER: open the account', output: 'done', snapshot: 'shop', wait_seconds: 0 });
    const runId = started.raw.structuredContent.run_id;
    await reached.promise;
    const hostSave = await srv.call('snapshot_save', { name: 'shop' });
    assert.match(hostSave.text, /^Refreshed snapshot "shop" \(v4, /);
    release.open();
    const newer = await srv.call('agent_wait', { run_id: runId, wait_seconds: 60 });
    assert.equal(newer.raw.structuredContent.status, 'completed', newer.text);
    assert.deepEqual(newer.raw.structuredContent.snapshot, { name: 'shop', version: 3 });
    assert.deepEqual(newer.raw.structuredContent.snapshot_saved, { name: 'shop', version: null, action: 'skipped', reason: 'v4 was saved meanwhile' });
    assert.match(newer.text, /Saved sign-in "shop" was not refreshed: v4 was saved meanwhile\./);

    // the agent signed out: nothing worth saving
    policies.set('MARKER-SKIP-SIGNED-OUT', (req) => (req.step === 1 ? call('browser_navigate', { url: `${fx.baseUrl}/logout` }) : call('finish', { output: 'signed out' })));
    const out = await srv.call('agent_run', { task: 'MARKER-SKIP-SIGNED-OUT: sign out', output: 'done', snapshot: 'shop' });
    assert.deepEqual(out.raw.structuredContent.snapshot_saved, {
      name: 'shop',
      version: null,
      action: 'skipped',
      reason: `the agent's browser had no sign-in cookies for ${host} at the end`,
    });

    // a job that did not succeed never overwrites the sign-in
    policies.set('MARKER-SKIP-FAILED', () => call('finish', { output: 'could not do it', success: false }));
    const failed = await srv.call('agent_run', { task: 'MARKER-SKIP-FAILED: try', output: 'done', snapshot: 'shop' });
    assert.equal(failed.raw.structuredContent.success, false);
    assert.equal(failed.raw.structuredContent.snapshot_saved, undefined);
    assert.equal(entry(await srv.call('snapshot_list'), 'shop').version, 4);
  });

  test('save_sign_in keeps a sign-in the job made: it creates one snapshot, then refreshes that one; a snapshot the user deleted is never saved again', async () => {
    const results: string[] = [];
    const created = gate();
    const deleted = gate();
    policies.set('MARKER-SIGNIN-CREATE', async (req) => {
      if (req.step > 3 && req.lastToolResult) results.push(req.lastToolResult);
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: `${fx.baseUrl}/login` });
        case 2:
          return {
            toolCalls: [
              { name: 'browser_fill', arguments: { selector: '#user', value: 'dave' } },
              { name: 'browser_fill', arguments: { selector: '#password', value: 'dave-password-77' } },
              { name: 'browser_click', arguments: { selector: '#signin' } },
            ],
          };
        case 3:
          return call('save_sign_in', { name: 'Fixture Dave', description: 'Fixture shop — dave' });
        case 4:
          // a job saves at most one new snapshot: another name is refused, not saved into the first one
          return call('save_sign_in', { name: 'another-one', description: 'Another account' });
        case 5:
          // a second save in the same job refreshes the snapshot it created
          return call('save_sign_in', {});
        case 6:
          created.open();
          await deleted.promise;
          return call('save_sign_in', {});
        default:
          return call('finish', { output: 'signed in as dave' });
      }
    });
    const started = await srv.call('agent_run', { task: 'MARKER-SIGNIN-CREATE: sign in as dave', output: 'who is signed in', wait_seconds: 0 });
    const runId = started.raw.structuredContent.run_id;
    runIds.push(runId);
    await created.promise;
    assert.match(results[0]!, new RegExp(`^Saved: created snapshot "fixture-dave" \\(v1\\): 1 cookie for ${esc(host)}, and the site storage of ${esc(origin)}\\. Later jobs can start signed in with it\\.`));
    assert.equal(results[1], 'Error: you already saved snapshot "fixture-dave" in this job, and a job saves at most one new snapshot. To update it, call save_sign_in without a name.');
    assert.match(results[2]!, /^Saved: refreshed snapshot "fixture-dave" \(v2\)/);

    // the host sees it and can use it in its own browser
    const list = await srv.call('snapshot_list');
    assert.match(list.text, new RegExp(`^- fixture-dave — Fixture shop — dave · 1 cookie for ${esc(host)} · storage for 1 site · v2, updated just now by sub-agent run ${runId} · loaded in: sub-agent run ${runId} \\(active\\)$`, 'm'));
    assert.equal(entry(list, 'another-one'), undefined);
    assert.equal((await srv.call('snapshot_load', { name: 'fixture-dave' })).isError, false);
    assert.deepEqual(await accountPage(srv, fx), { who: 'Signed in as dave', profile: 'profile: restored' });

    // the user deletes it on the dashboard while the job still runs
    const del = await dashboardDelete(srv, 'fixture-dave');
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, 'fixture-dave');
    assert.deepEqual([...del.body.loaded_in].sort(), [`agent-${runId}`, 'main'].sort());
    deleted.open();
    const done = await srv.call('agent_wait', { run_id: runId, wait_seconds: 60 });
    assert.equal(done.raw.structuredContent.status, 'completed', done.text);
    assert.equal(results[3], 'Error: The user deleted snapshot "fixture-dave"; do not save it again.');
    assert.deepEqual(done.raw.structuredContent.snapshot_saved, { name: 'fixture-dave', version: 2, action: 'created' });
    assert.match(done.text, /The agent saved its sign-in as snapshot "fixture-dave" \(v2\): pass \{"snapshot": "fixture-dave"\} to agent_run/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('fixture-dave') || f.startsWith('another-one')), [], 'nothing was re-created');
    assert.equal(entry(await srv.call('snapshot_list'), 'fixture-dave'), undefined);
  });

  test('save_sign_in refuses a taken name, a missing name or description, and a browser without sign-in cookies; in a job started with a snapshot it refreshes that one', async () => {
    const results: string[] = [];
    policies.set('MARKER-SIGNIN-REFUSE', (req) => {
      if (req.step > 2 && req.lastToolResult) results.push(req.lastToolResult);
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
        case 2:
          return call('save_sign_in', {});
        case 3:
          return call('save_sign_in', { name: 'shop', description: 'Fixture shop — someone else' });
        case 4:
          return call('save_sign_in', { name: 'empty-jar', description: 'Nothing' });
        default:
          return call('finish', { output: 'nothing saved', success: false });
      }
    });
    const refused = await srv.call('agent_run', { task: 'MARKER-SIGNIN-REFUSE: save', output: 'x' });
    assert.equal(refused.raw.structuredContent.status, 'completed', refused.text);
    assert.match(results[0]!, /^Error: give a name and a description for the new snapshot/);
    assert.equal(results[1], 'Error: a snapshot named "shop" already exists; choose another name.');
    assert.equal(results[2], `Error: This browser has no sign-in cookies for ${host}; no snapshot was saved. Sign in first.`);
    assert.equal(refused.raw.structuredContent.snapshot_saved, undefined);

    const started: string[] = [];
    policies.set('MARKER-SIGNIN-STARTED', (req) => {
      if (req.step === 1) {
        started.push(String(req.body.tools.find((t: any) => t.function.name === 'save_sign_in')?.function.description));
        return call('browser_navigate', { url: `${fx.baseUrl}/account` });
      }
      if (req.step === 2) return call('save_sign_in', { name: 'renamed', description: 'A new description' });
      started.push(String(req.lastToolResult));
      return call('finish', { output: 'kept' });
    });
    const res = await srv.call('agent_run', { task: 'MARKER-SIGNIN-STARTED: keep the sign-in', output: 'x', snapshot: 'shop' });
    assert.match(started[0]!, /Your job started with the saved sign-in "shop": this updates it\./);
    assert.match(started[1]!, /^Saved: refreshed snapshot "shop" \(v5\): .* Its description stays as it is: only the host changes it\.$/);
    // save_sign_in moved this browser to v5, so the refresh at the end is v6
    assert.deepEqual(res.raw.structuredContent.snapshot_saved, { name: 'shop', version: 6, action: 'refreshed' });
    const shop = entry(await srv.call('snapshot_list'), 'shop');
    assert.equal(shop.description, 'Fixture shop — alice');
    assert.equal(entry(await srv.call('snapshot_list'), 'renamed'), undefined);
  });

  test('allow_evaluate gives a signed-in job browser_evaluate; update_snapshot false keeps the snapshot as it was', async () => {
    let tools: string[] = [];
    let description = '';
    policies.set('MARKER-SNAP-EVAL', (req) => {
      tools = req.toolNames;
      description = String(req.body.tools.find((t: any) => t.function.name === 'save_sign_in')?.function.description);
      return call('finish', { output: 'ok' });
    });
    const before = entry(await srv.call('snapshot_list'), 'shop').version;
    const res = await srv.call('agent_run', { task: 'MARKER-SNAP-EVAL: check', output: 'ok', snapshot: 'shop', allow_evaluate: true, update_snapshot: false });
    assert.equal(res.raw.structuredContent.status, 'completed', res.text);
    assert.ok(tools.includes('browser_evaluate'));
    assert.match(description, /Give a short name and a description of the site and account\./, 'with update_snapshot false it does not update the snapshot');
    assert.deepEqual(res.raw.structuredContent.snapshot, { name: 'shop', version: before });
    assert.equal(res.raw.structuredContent.snapshot_saved, undefined);
    assert.equal(entry(await srv.call('snapshot_list'), 'shop').version, before);
  });

  test('a snapshot the user deletes during the run is not saved again at the end', async () => {
    await signIn(srv, fx, 'tess');
    assert.equal((await srv.call('snapshot_save', { name: 'temp-shop', description: 'Fixture shop — tess' })).isError, false);
    const reached = gate();
    const release = gate();
    policies.set('MARKER-SKIP-DELETED', async (req) => {
      if (req.step === 1) return call('browser_navigate', { url: `${fx.baseUrl}/account` });
      reached.open();
      await release.promise;
      return call('finish', { output: 'done' });
    });
    const started = await srv.call('agent_run', { task: 'MARKER-SKIP-DELETED: open the account', output: 'x', snapshot: 'temp-shop', wait_seconds: 0 });
    const runId = started.raw.structuredContent.run_id;
    await reached.promise;
    const del = await dashboardDelete(srv, 'temp-shop');
    assert.equal(del.status, 200);
    assert.ok(del.body.loaded_in.includes(`agent-${runId}`), 'it was loaded in the agent browser');
    release.open();
    const done = await srv.call('agent_wait', { run_id: runId, wait_seconds: 60 });
    assert.equal(done.raw.structuredContent.status, 'completed', done.text);
    assert.deepEqual(done.raw.structuredContent.snapshot_saved, { name: 'temp-shop', version: null, action: 'skipped', reason: 'the user deleted it during the run' });
    assert.match(done.text, /Saved sign-in "temp-shop" was not refreshed: the user deleted it during the run\./);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('temp-shop')), [], 'never re-created');
  });

  test('an agent browser whose engine restarts gets its saved sign-in back and is told so', async () => {
    let notice = '';
    let page = '';
    policies.set('MARKER-SNAP-RECONNECT', async (req) => {
      if (req.step === 1) return call('browser_navigate', { url: `${fx.baseUrl}/index.html` });
      if (req.step === 2) {
        await killEngine(srv, 'obscuraIsolated');
        return call('browser_navigate', { url: `${fx.baseUrl}/account` });
      }
      if (req.step === 3) {
        notice = String(req.lastToolResult);
        return call('browser_get_text', { selector: 'body' });
      }
      page = String(req.lastToolResult);
      return call('finish', { output: 'ok' });
    });
    const res = await srv.call('agent_run', { task: 'MARKER-SNAP-RECONNECT: open the account', output: 'ok', snapshot: 'shop', update_snapshot: false });
    assert.equal(res.isError, false, res.text);
    assert.match(notice, /The browser connection was lost \(.*\)\. The browser was reset; your saved sign-in "shop" was re-applied; open the page again\./);
    assert.doesNotMatch(notice, /snapshot_load/, 'sub-agents have no snapshot tools');
    assert.match(page, /Signed in as alice/);
    assert.match(page, /profile: restored/);
  });

  test('no cookie or storage value reaches the logs, /api/state, /api/snapshots, /api/agents/:id or the transcripts', async () => {
    await sleep(500);
    const secrets = [...fx.sessions.entries()].flatMap(([token, s]) => [token, s.profile]);
    assert.ok(secrets.length >= 6, 'alice twice and dave signed in');
    const blobs: Array<[string, string]> = [
      ['log file', readFileSync(path.join(srv.logDir!, 'current.log'), 'utf8')],
      ['/api/state', JSON.stringify(await getJson(srv, '/api/state'))],
      ['/api/snapshots', JSON.stringify(await getJson(srv, '/api/snapshots'))],
    ];
    const state = await getJson(srv, '/api/state');
    for (const run of state.history.agents) blobs.push([`/api/agents/${run.id}`, JSON.stringify(await getJson(srv, `/api/agents/${run.id}`))]);
    const transcripts = path.join(srv.logDir!, 'agent-runs');
    for (const f of readdirSync(transcripts)) blobs.push([`transcript ${f}`, readFileSync(path.join(transcripts, f), 'utf8')]);
    assert.ok(blobs.length > 8);
    for (const [where, text] of blobs) {
      for (const secret of [...secrets, 'dave-password-77', 'fixture-password']) assert.ok(!text.includes(secret), `${secret} in ${where}`);
      assert.ok(!text.includes('hasOwnProperty.call(seed'), `the storage seed script in ${where}`);
    }
  });
});

describe('sub-agents without save_sign_in', { skip: OWN }, () => {
  let fx: FixtureServer;
  let llm: FakeLlm;
  before(async () => {
    fx = await startFixtureServer();
    llm = await startFakeLlm(dispatch);
  });
  after(async () => {
    await llm?.close();
    await fx?.close();
  });

  test('save_sign_in is offered only when the snapshots group is enabled and AGENT_SNAPSHOT_SAVE is on', async () => {
    const seen: Array<{ tools: string[]; system: string }> = [];
    policies.set('MARKER-NO-SAVE', (req) => {
      seen.push({ tools: req.toolNames, system: String(req.messages[0].content) });
      return call('finish', { output: 'ok' });
    });
    const base = { AGENT_LLM_URL: llm.url, AGENT_LLM_MODEL: 'fake-model', SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-scripts-')) };
    for (const env of [{ TOOLSETS: 'core,content,forms,agents' }, { AGENT_SNAPSHOT_SAVE: 'false' }, {}] as Array<Record<string, string>>) {
      const srv = await startTestServer({ ...base, ...env });
      try {
        const names = (await srv.client.listTools()).tools.map((t) => t.name);
        assert.ok(names.includes('agent_run'));
        assert.equal(names.includes('snapshot_save'), !env.TOOLSETS, JSON.stringify(env));
        assert.equal(/Snapshots are saved sign-ins/.test(srv.client.getInstructions() ?? ''), !env.TOOLSETS);
        const res = await srv.call('agent_run', { task: 'MARKER-NO-SAVE: check', output: 'ok' });
        assert.equal(res.raw.structuredContent.status, 'completed', res.text);
      } finally {
        await srv.stop();
      }
    }
    const [noGroup, off, on] = seen;
    for (const s of [noGroup!, off!]) {
      assert.ok(!s.tools.includes('save_sign_in'));
      assert.doesNotMatch(s.system, /save_sign_in/);
    }
    assert.ok(on!.tools.includes('save_sign_in'));
    assert.match(on!.system, /call save_sign_in before finish so the next job does not have to sign in again/);
  });
});
