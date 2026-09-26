import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import pino from 'pino';
import type { CookieOut } from '../../src/browser/storage-state.ts';
import { loadConfig } from '../../src/config.ts';
import { Hub } from '../../src/dashboard/hub.ts';
import { LogTap } from '../../src/logger.ts';
import { SnapshotService, domainsText, inScope, normalizeFilter, siteOfHost } from '../../src/snapshots/service.ts';
import {
  MAX_SNAPSHOTS,
  SnapshotDecryptError,
  SnapshotError,
  SnapshotNotFoundError,
  SnapshotStore,
  normalizeSnapshotName,
} from '../../src/snapshots/store.ts';

const silent = pino({ level: 'silent' });
const POSIX = process.platform !== 'win32';

const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'sbm-snapstore-')), 'snaps');
const mode = (file: string) => statSync(file).mode & 0o777;

function cookie(name: string, value: string, extra: Partial<CookieOut> = {}): CookieOut {
  return { name, value, domain: 'shop.example', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax', ...extra };
}

const origin = (value: string) => ({ origin: 'https://shop.example', localStorage: [{ name: 'profile', value }], sessionStorage: [] });

function create(store: SnapshotStore, name: string, secret = 'cookie-secret-1') {
  return store.create({
    name,
    description: 'Shop — test account',
    domains: ['shop.example'],
    cookies: [cookie('session', secret)],
    origins: [origin(`storage-${secret}`)],
    by: { client: 'unit-test' },
  });
}

describe('snapshot names', () => {
  test('names are trimmed, lowercased and get "-" for whitespace', () => {
    assert.equal(normalizeSnapshotName('  Amazon Work '), 'amazon-work');
    assert.equal(normalizeSnapshotName('Shop\t\tDE'), 'shop-de');
    assert.equal(normalizeSnapshotName('a_b-c9'), 'a_b-c9');
    assert.equal(normalizeSnapshotName('x'.repeat(64)), 'x'.repeat(64));
  });

  test('path traversal, separators, NUL and other characters are refused', () => {
    for (const bad of ['', '   ', '..', '.', '.hidden', '/', 'a/b', '..\\x', '%2f', '../etc/passwd', 'a\u0000b', '-x', '_x', 'x'.repeat(65), 'naïve', 'a.b', 'a:b']) {
      assert.throws(() => normalizeSnapshotName(bad), (err: Error) => err instanceof SnapshotError && /Invalid snapshot name/.test(err.message), JSON.stringify(bad));
    }
  });
});

describe('snapshot store', () => {
  test('creates an owner-only folder and files; the metadata holds counts and domains, never cookie or storage values', { skip: !POSIX }, async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    const meta = await store.create({
      name: 'shop',
      description: 'Shop — test account',
      domains: ['shop.example'],
      cookies: [
        cookie('session', 'cookie-secret-1'),
        cookie('prefs', 'p', { domain: '.cdn.shop.example', expires: 4_102_444_800, httpOnly: false }),
        cookie('old', 'o', { expires: 1_000_000_000 }),
      ],
      origins: [origin('storage-secret-1')],
      by: { client: 'unit-test' },
    });
    assert.equal(mode(d), 0o700);
    assert.deepEqual(readdirSync(d).sort(), ['shop.json', 'shop.state']);
    for (const f of readdirSync(d)) assert.equal(mode(path.join(d, f)), 0o600, f);
    assert.equal(meta.version, 1);
    assert.equal(meta.cookieCount, 3);
    assert.equal(meta.sessionCookieCount, 1);
    assert.deepEqual(meta.cookieDomains, ['cdn.shop.example', 'shop.example']);
    assert.deepEqual(meta.expiries, [1_000_000_000, 4_102_444_800], 'sorted expiry times, no names');
    assert.deepEqual(meta.origins, [{ origin: 'https://shop.example', localStorage: 1, sessionStorage: 0 }]);
    assert.deepEqual(meta.createdBy, { client: 'unit-test' });
    assert.equal(meta.encrypted, false);
    const json = readFileSync(path.join(d, 'shop.json'), 'utf8');
    for (const secret of ['cookie-secret-1', 'storage-secret-1', '"session"', '"prefs"', 'profile']) assert.ok(!json.includes(secret), `${secret} in the metadata`);
    // without a key the state is plain JSON (0600)
    const state = await store.readState('shop');
    assert.equal(state.cookies.find((c) => c.name === 'session')?.value, 'cookie-secret-1');
    assert.equal(state.origins[0]?.localStorage[0]?.value, 'storage-secret-1');
  });

  test('an existing folder readable by others is restricted to its owner', { skip: !POSIX }, async () => {
    const d = dir();
    mkdirSync(d, { mode: 0o755 });
    await new SnapshotStore(d, undefined, silent).list();
    assert.equal(mode(d), 0o700);
  });

  test('create is create-only: an existing name, even an incomplete one, is never overwritten', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await create(store, 'shop', 'first');
    await assert.rejects(create(store, 'shop', 'second'), /A snapshot named "shop" already exists/);
    assert.equal((await store.readState('shop')).cookies[0]?.value, 'first');
    // a state file without metadata (an interrupted write, a hand-copied file) blocks the name too
    writeFileSync(path.join(d, 'orphan.state'), '{"version":1,"cookies":[],"origins":[]}\n', { mode: 0o600 });
    await assert.rejects(create(store, 'orphan'), /already exists/);
    assert.equal(readFileSync(path.join(d, 'orphan.state'), 'utf8'), '{"version":1,"cookies":[],"origins":[]}\n');
    assert.throws(() => store.create({ name: '../x', description: 'd', domains: ['a.example'], cookies: [], origins: [], by: {} }), /Invalid snapshot name/);
  });

  test('update, describe and recordLoad never create: a missing or deleted snapshot stays gone', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    const build = async () => ({ cookies: [cookie('session', 'again')], origins: [] });
    await assert.rejects(store.update('ghost', {}, build), SnapshotNotFoundError);
    await assert.rejects(store.describe('ghost', 'x'), SnapshotNotFoundError);
    await assert.rejects(store.recordLoad('ghost'), SnapshotNotFoundError);
    await create(store, 'shop');
    await store.delete('shop');
    await assert.rejects(store.update('shop', { runId: 'r1' }, build), SnapshotNotFoundError);
    assert.deepEqual(readdirSync(d).filter((f) => !f.startsWith('.')), [], 'no file was written');
  });

  test('update saves a new version under the per-name lock; describe keeps the version; loads are counted', async () => {
    const store = new SnapshotStore(dir(), undefined, silent);
    const v1 = await create(store, 'shop');
    // concurrent saves are serialized: each sees the version the one before it wrote
    const seen: number[] = [];
    const outs = await Promise.all(
      [1, 2, 3].map((i) =>
        store.update('shop', { runId: `r${i}` }, async (current) => {
          seen.push(current.version);
          return { cookies: [cookie('session', `v-${i}`)], origins: [] };
        }),
      ),
    );
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(outs.map((m) => m.version), [2, 3, 4]);
    const latest = await store.get('shop');
    assert.equal(latest.version, 4);
    assert.equal(latest.createdAt, v1.createdAt);
    assert.deepEqual(latest.createdBy, { client: 'unit-test' });
    assert.deepEqual(latest.updatedBy, { runId: 'r3' });
    assert.equal((await store.readState('shop')).version, 4);

    // a refusal inside the lock (e.g. a version conflict) writes nothing
    await assert.rejects(
      store.update('shop', {}, async () => {
        throw new SnapshotError('conflict');
      }),
      /conflict/,
    );
    assert.equal((await store.get('shop')).version, 4);

    const described = await store.describe('shop', 'Shop — second account');
    assert.equal(described.version, 4);
    assert.equal((await store.get('shop')).description, 'Shop — second account');
    await store.recordLoad('shop');
    await store.recordLoad('shop');
    const loaded = await store.get('shop');
    assert.equal(loaded.loads, 2);
    assert.ok(loaded.lastLoadedAt);
    assert.equal(loaded.version, 4, 'counting a load is not a new version');
  });

  test('delete removes the saved sign-in first, then the metadata; either file alone is enough to delete', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await create(store, 'shop');
    // make the metadata undeletable (a folder in its place): the credentials must be gone anyway
    rmSync(path.join(d, 'shop.json'));
    mkdirSync(path.join(d, 'shop.json'));
    await assert.rejects(store.delete('shop'));
    assert.equal(existsSync(path.join(d, 'shop.state')), false, 'the state file was removed first');
    rmSync(path.join(d, 'shop.json'), { recursive: true });

    await create(store, 'meta-only');
    rmSync(path.join(d, 'meta-only.state'));
    await store.delete('meta-only');
    writeFileSync(path.join(d, 'state-only.state'), '{}', { mode: 0o600 });
    await store.delete('state-only');
    assert.deepEqual(readdirSync(d), []);
    await assert.rejects(store.delete('shop'), SnapshotNotFoundError);
  });

  test('list reads metadata only and reports incomplete and out-of-date entries', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await create(store, 'good');
    await create(store, 'no-state');
    rmSync(path.join(d, 'no-state.state'));
    await create(store, 'stale');
    // the state was written after the metadata (a crash between the two writes)
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(d, 'stale.state'), later, later);
    writeFileSync(path.join(d, 'broken.state'), '{}', { mode: 0o600 });
    writeFileSync(path.join(d, 'broken.json'), '{"name": "broken"}', { mode: 0o600 });
    writeFileSync(path.join(d, 'copied.state'), '{}', { mode: 0o600 });
    writeFileSync(path.join(d, 'copied.json'), readFileSync(path.join(d, 'good.json')), { mode: 0o600 });
    writeFileSync(path.join(d, 'Not A Name.state'), '{}', { mode: 0o600 });
    const listing = await store.list();
    const byName = new Map(listing.snapshots.map((m) => [m.name, m]));
    assert.deepEqual([...byName.keys()].sort(), ['good', 'no-state', 'stale']);
    assert.equal(byName.get('no-state')!.incomplete, true);
    assert.equal(byName.get('stale')!.stale, true);
    assert.equal(byName.get('good')!.stale, undefined);
    assert.deepEqual(listing.incomplete, ['broken', 'copied'], 'state files without valid metadata (a copy naming another snapshot is not valid)');
    await assert.rejects(store.get('broken'), /metadata of snapshot "broken"/);
    await assert.rejects(store.get('missing'), SnapshotNotFoundError);
  });

  test('state and metadata files must be regular files, not symbolic links', { skip: !POSIX }, async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await create(store, 'shop');
    const outside = path.join(path.dirname(d), 'outside.json');
    writeFileSync(outside, '{"version":1,"cookies":[],"origins":[]}');
    rmSync(path.join(d, 'shop.state'));
    symlinkSync(outside, path.join(d, 'shop.state'));
    await assert.rejects(store.readState('shop'), /symbolic link|not a regular file/);
    await assert.rejects(
      store.update('shop', {}, async () => ({ cookies: [cookie('session', 'x')], origins: [] })),
      /not a regular file/,
    );
    assert.equal(readFileSync(outside, 'utf8'), '{"version":1,"cookies":[],"origins":[]}', 'the link target was not written');
  });

  test('a state larger than 5 MB and more than 500 snapshots are refused, and the limit text never suggests deleting', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await assert.rejects(
      store.create({ name: 'huge', description: 'd', domains: ['shop.example'], cookies: [cookie('big', 'x'.repeat(6 * 1024 * 1024))], origins: [], by: {} }),
      /too large .* at most 5 MB/,
    );
    assert.equal(existsSync(path.join(d, 'huge.state')), false);
    for (let i = 0; i < MAX_SNAPSHOTS; i++) writeFileSync(path.join(d, `s${i}.json`), '{}');
    await assert.rejects(create(store, 'one-more'), (err: Error) => {
      assert.equal(err.message, 'Snapshot limit (500) reached. Ask your user which snapshot to delete; never delete one on your own.');
      return true;
    });
  });

  test('leftover temp files are swept only when they are old', async () => {
    const d = dir();
    const store = new SnapshotStore(d, undefined, silent);
    await create(store, 'shop');
    writeFileSync(path.join(d, 'shop.0a1b2c.tmp'), 'old');
    writeFileSync(path.join(d, 'shop.3d4e5f.tmp'), 'in progress');
    const old = new Date(Date.now() - 120_000);
    utimesSync(path.join(d, 'shop.0a1b2c.tmp'), old, old);
    assert.equal(await store.sweepTmp(), 1);
    assert.deepEqual(readdirSync(d).sort(), ['shop.3d4e5f.tmp', 'shop.json', 'shop.state']);
  });
});

describe('snapshot encryption at rest', () => {
  test('with a key the state file is AES-256-GCM encrypted and reads back the same', async () => {
    const d = dir();
    const store = new SnapshotStore(d, 'unit-test-key', silent);
    const meta = await create(store, 'shop', 'enc-cookie-secret');
    assert.equal(meta.encrypted, true);
    const raw = readFileSync(path.join(d, 'shop.state'), 'utf8');
    assert.ok(!raw.includes('enc-cookie-secret') && !raw.includes('storage-enc-cookie-secret'), 'no value in the encrypted file');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.v, 1);
    assert.equal(envelope.alg, 'aes-256-gcm');
    assert.deepEqual(Object.keys(envelope.kdf).sort(), ['n', 'p', 'r']);
    for (const key of ['salt', 'iv', 'tag', 'data']) assert.equal(typeof envelope[key], 'string', key);
    const state = await store.readState('shop');
    assert.equal(state.cookies[0]?.value, 'enc-cookie-secret');
    assert.equal(state.origins[0]?.localStorage[0]?.value, 'storage-enc-cookie-secret');
    // every write gets its own salt and IV
    await store.update('shop', {}, async () => ({ cookies: [cookie('session', 'enc-cookie-secret')], origins: [] }));
    const again = JSON.parse(readFileSync(path.join(d, 'shop.state'), 'utf8'));
    assert.notEqual(again.salt, envelope.salt);
    assert.notEqual(again.iv, envelope.iv);
  });

  test('a wrong or missing key is a clear error, never "no such snapshot"', async () => {
    const d = dir();
    await create(new SnapshotStore(d, 'key-one', silent), 'shop');
    const message = 'cannot decrypt snapshot "shop": SNAPSHOTS_KEY is missing or differs from the one used to save it';
    await assert.rejects(new SnapshotStore(d, 'key-two', silent).readState('shop'), (err: Error) => err instanceof SnapshotDecryptError && err.message === message);
    await assert.rejects(new SnapshotStore(d, undefined, silent).readState('shop'), (err: Error) => err instanceof SnapshotDecryptError && err.message === message);
    // the empty string (SNAPSHOTS_KEY=) means no key
    await assert.rejects(new SnapshotStore(d, '', silent).readState('shop'), SnapshotDecryptError);
  });

  test('a state file copied over another snapshot does not decrypt (the name is bound to it)', async () => {
    const d = dir();
    const store = new SnapshotStore(d, 'same-key', silent);
    await create(store, 'personal', 'personal-secret');
    await create(store, 'work', 'work-secret');
    copyFileSync(path.join(d, 'personal.state'), path.join(d, 'work.state'));
    await assert.rejects(store.readState('work'), SnapshotDecryptError);
    assert.equal((await store.readState('personal')).cookies[0]?.value, 'personal-secret');
  });

  test('a hand-edited envelope cannot make the key derivation use huge memory', async () => {
    const d = dir();
    const store = new SnapshotStore(d, 'k', silent);
    await create(store, 'shop');
    const file = path.join(d, 'shop.state');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...envelope, kdf: { n: 2 ** 30, r: 8, p: 1 } }), { mode: 0o600 });
    await assert.rejects(store.readState('shop'), /unsupported encryption format/);
  });

  test('plain state files saved before a key was set are encrypted once, keeping their content', async () => {
    const d = dir();
    await create(new SnapshotStore(d, undefined, silent), 'shop', 'plain-secret');
    assert.match(readFileSync(path.join(d, 'shop.state'), 'utf8'), /plain-secret/);
    const keyed = new SnapshotStore(d, 'new-key', silent);
    assert.deepEqual(await keyed.encryptPlaintext(), ['shop']);
    const raw = readFileSync(path.join(d, 'shop.state'), 'utf8');
    assert.ok(!raw.includes('plain-secret'));
    assert.equal(JSON.parse(raw).alg, 'aes-256-gcm');
    assert.equal((await keyed.get('shop')).encrypted, true);
    assert.equal((await keyed.readState('shop')).cookies[0]?.value, 'plain-secret');
    assert.deepEqual(await keyed.encryptPlaintext(), [], 'already encrypted');
    assert.deepEqual(await new SnapshotStore(d, undefined, silent).encryptPlaintext(), [], 'nothing to do without a key');
  });
});

describe('snapshot domain filter', () => {
  test('a site keeps its subdomains and the parent-domain cookies a browser sends to it', () => {
    assert.equal(inScope('example.com', ['www.example.com']), true, 'parent-domain cookie for a www filter');
    assert.equal(inScope('.example.com', ['www.example.com']), true);
    assert.equal(inScope('www.example.com', ['example.com']), true);
    assert.equal(inScope('a.b.example.com', ['example.com']), true);
    assert.equal(inScope('shop.example.com', ['www.example.com']), false, 'a sibling subdomain is not sent to www');
    assert.equal(inScope('com', ['www.example.com']), false, 'a bare TLD never matches');
    assert.equal(inScope('evil-example.com', ['example.com']), false);
    assert.equal(inScope('example.com.evil.net', ['example.com']), false);
    assert.equal(inScope('anything.net', ['*']), true);
    assert.equal(inScope('127.0.0.1', ['127.0.0.1']), true);
  });

  test('filter entries are normalized sites; "*" alone means every cookie', () => {
    assert.deepEqual(normalizeFilter(['https://WWW.Example.com/path', '.shop.example', 'example.com']), ['example.com', 'shop.example', 'www.example.com']);
    assert.deepEqual(normalizeFilter(['a.example', '*']), ['*']);
    assert.throws(() => normalizeFilter(['  ']), /Invalid domain|domains is empty/);
    assert.throws(() => normalizeFilter(['exa mple.com']), /Invalid domain/);
    assert.equal(siteOfHost('WWW.Shop.Example'), 'shop.example');
    assert.equal(siteOfHost('127.0.0.1'), '127.0.0.1');
    assert.equal(domainsText(['*']), 'every site');
    assert.equal(domainsText(['a.x', 'b.x', 'c.x', 'd.x']), 'a.x, b.x, c.x and 1 more');
  });
});

describe('snapshot service list', () => {
  test('the dashboard view counts expired cookies, holds no values and publishes to the hub', async () => {
    const d = dir();
    const config = loadConfig({ SNAPSHOTS_DIR: d });
    const hub = new Hub(new LogTap());
    const registry = { browser: () => null, list: () => [] } as any;
    const svc = new SnapshotService({ config, log: silent, hub }, registry);
    const now = Math.floor(Date.now() / 1000);
    await svc.store.create({
      name: 'shop',
      description: 'Shop — test account',
      domains: ['shop.example'],
      cookies: [cookie('session', 'svc-secret'), cookie('gone', 'g', { expires: now - 60 }), cookie('soon', 's', { expires: now + 3_600 })],
      origins: [origin('svc-storage-secret')],
      by: { runId: 'r1234567' },
    });
    writeFileSync(path.join(d, 'orphan.state'), '{}', { mode: 0o600 });
    const payload = await svc.list();
    assert.equal(payload.dir, d);
    assert.equal(payload.encrypted, false);
    assert.equal(payload.unencrypted_count, 1);
    const shop = payload.snapshots.find((s) => s.name === 'shop')!;
    assert.equal(shop.cookie_count, 3);
    assert.equal(shop.expired_count, 1);
    assert.equal(shop.next_expiry, new Date((now + 3_600) * 1000).toISOString());
    assert.deepEqual(shop.created_by, { run_id: 'r1234567' });
    assert.deepEqual(shop.origins, [{ origin: 'https://shop.example', local_storage: 1, session_storage: 0 }]);
    assert.deepEqual(shop.loaded_in, []);
    assert.deepEqual(payload.snapshots.find((s) => s.name === 'orphan'), { name: 'orphan', incomplete: true, loaded_in: [], active_in: [] });
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('svc-secret') && !text.includes('svc-storage-secret') && !text.includes('"session"'), text);
    assert.deepEqual(hub.history().snapshots, payload, 'viewers that connect later get the list');
  });
});

describe('snapshot configuration', () => {
  test('defaults: data/snapshots, no key, sub-agents may save sign-ins', () => {
    const c = loadConfig({});
    assert.match(c.snapshots.dir, /data[/\\]snapshots$/);
    assert.equal(c.snapshots.key, undefined);
    assert.equal(c.agent.snapshotSave, true);
    assert.equal(loadConfig({ SNAPSHOTS_KEY: '' }).snapshots.key, undefined, 'an empty key is no key');
    assert.equal(loadConfig({ SNAPSHOTS_KEY: 'k' }).snapshots.key, 'k');
    assert.equal(loadConfig({ AGENT_SNAPSHOT_SAVE: 'false' }).agent.snapshotSave, false);
    assert.throws(() => loadConfig({ AGENT_SNAPSHOT_SAVE: 'maybe' }), /AGENT_SNAPSHOT_SAVE/);
  });

  test('saved sign-ins never go into the log folder or the scripts folder', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'sbm-snapcfg-'));
    const logs = path.join(base, 'logs');
    assert.throws(() => loadConfig({ LOG_DIR: logs, SNAPSHOTS_DIR: path.join(logs, 'snapshots') }), /SNAPSHOTS_DIR: must not be inside LOG_DIR/);
    assert.throws(() => loadConfig({ LOG_DIR: logs, SNAPSHOTS_DIR: logs }), /SNAPSHOTS_DIR/);
    assert.throws(() => loadConfig({ SCRIPTS_DIR: path.join(base, 's'), SNAPSHOTS_DIR: `${path.join(base, 's')}${path.sep}` }), /SNAPSHOTS_DIR: must not be the same folder as SCRIPTS_DIR/);
    assert.equal(loadConfig({ LOG_DIR: logs, SNAPSHOTS_DIR: path.join(base, 'logs-snapshots') }).snapshots.dir, path.join(base, 'logs-snapshots'), 'a sibling with a similar name is fine');
  });
});
