import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/setup-lmstudio.mjs');
const temp = mkdtempSync(path.join(tmpdir(), 'sbm-setup-test-'));
let counter = 0;

/** A fresh fake home directory (never the real ~/.lmstudio). */
function home(): string {
  const dir = path.join(temp, `home-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(args: string[], env: Record<string, string> = {}) {
  const { LMSTUDIO_HOME: _ignored, ...base } = process.env;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...base, ...env } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const EXISTING = {
  mcpServers: {
    brave: { command: 'npx', args: ['-y', 'brave-mcp'], env: { BRAVE_API_KEY: 'BSA-secret-key-123' } },
    'stealth-browser': { url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Bearer tok-SECRET-999' }, timeout: 60000, extra: true },
  },
  otherTopLevel: 1,
};

describe('setup-lmstudio.mjs', () => {
  after(() => rmSync(temp, { recursive: true, force: true }));

  test('creates mcp.json with the default entry', () => {
    const h = home();
    const file = path.join(h, 'cfg', 'mcp.json');
    const r = run(['--config', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify({ mcpServers: { 'stealth-browser': { url: 'http://127.0.0.1:8931/mcp', timeout: 180000 } } }, null, 2)}\n`);
    assert.match(r.stdout, /Added "stealth-browser"/);
  });

  test('merges into an existing file, keeps other servers and writes a backup', () => {
    const h = home();
    const file = path.join(h, 'mcp.json');
    writeFileSync(file, JSON.stringify(EXISTING));
    const r = run(['--config', file, '--timeout', '200000']);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.mcpServers.brave, EXISTING.mcpServers.brave);
    assert.equal(data.otherTopLevel, 1);
    assert.deepEqual(data.mcpServers['stealth-browser'], {
      url: 'http://127.0.0.1:8931/mcp',
      headers: { Authorization: 'Bearer tok-SECRET-999' },
      timeout: 200000,
      extra: true,
    });
    assert.equal(readdirSync(h).filter((f) => f.startsWith('mcp.json.bak-')).length, 1);
  });

  test('--dry-run masks tokens and env secrets and writes nothing', () => {
    const h = home();
    const file = path.join(h, 'mcp.json');
    const original = JSON.stringify(EXISTING);
    writeFileSync(file, original);
    const r = run(['--config', file, '--dry-run', '--timeout', '200000']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /tok-SECRET-999|BSA-secret-key-123/);
    assert.match(r.stdout, /"Authorization": "Bearer <redacted>"/);
    assert.match(r.stdout, /"timeout": 200000/);
    assert.equal(readFileSync(file, 'utf8'), original);

    const short = run(['--config', file, '--dry-run', '--token', 'a']);
    assert.match(short.stdout, /"brave": \{/, 'a short token does not mangle the printed JSON');
  });

  test('updates the target of a symlinked mcp.json instead of replacing the link', () => {
    const h = home();
    const real = path.join(h, 'dotfiles', 'mcp.json');
    mkdirSync(path.dirname(real));
    writeFileSync(real, JSON.stringify({ mcpServers: {} }));
    const link = path.join(h, 'mcp.json');
    symlinkSync(real, link);
    const r = run(['--config', link]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink is kept');
    assert.ok(JSON.parse(readFileSync(real, 'utf8')).mcpServers['stealth-browser'], 'the real file was updated');
  });

  test('a token makes a world-readable file private to the user', () => {
    const h = home();
    const file = path.join(h, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    chmodSync(file, 0o644);
    const r = run(['--config', file, '--token', 's3cret-token']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers['stealth-browser'].headers.Authorization, 'Bearer s3cret-token');
  });

  test('finds LM Studio through ~/.lmstudio-home-pointer', () => {
    const h = home();
    const lmHome = path.join(h, 'elsewhere', 'lmstudio');
    writeFileSync(path.join(h, '.lmstudio-home-pointer'), `${lmHome}\n`);
    const r = run([], { HOME: h, USERPROFILE: h });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(JSON.parse(readFileSync(path.join(lmHome, 'mcp.json'), 'utf8')).mcpServers['stealth-browser']);
  });

  test('leaves invalid JSON untouched and rejects bad options', () => {
    const h = home();
    const file = path.join(h, 'mcp.json');
    writeFileSync(file, '{ not json');
    const r = run(['--config', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{ not json');
    assert.equal(run(['--config', file, '--name', 'Stealth_Browser']).code, 2);
    assert.equal(run(['--config', file, '--timeout', '1.5']).code, 2);
  });

  test('--print shows a deeplink whose config decodes to the entry', () => {
    const r = run(['--print', '--url', 'http://127.0.0.1:9000/mcp']);
    assert.equal(r.code, 0, r.stderr);
    const config = /lmstudio:\/\/add_mcp\?name=stealth-browser&config=([^\s]+)/.exec(r.stdout)?.[1];
    assert.ok(config, r.stdout);
    assert.deepEqual(JSON.parse(Buffer.from(decodeURIComponent(config), 'base64').toString('utf8')), { url: 'http://127.0.0.1:9000/mcp', timeout: 180000 });
  });
});
