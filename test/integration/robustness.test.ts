import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { ObscuraProcess } from '../../src/obscura/process.ts';
import { connectClient, startTestServer, type TestServer } from '../helpers/harness.ts';

// These exercise process startup and supervision, so they need a server the harness spawns and controls
// (custom env, a local log dir, a killable local pid). Skip them when MCP_URL points at an external container.
const FRESH = process.env.MCP_URL ? 'needs a harness-spawned server (not available with MCP_URL)' : false;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

interface RawServer {
  child: ChildProcess;
  out: () => string;
  baseUrl: string;
}

/** Raw-spawn `node src/main.ts`; keys whose value is null are removed from the child environment. */
function spawnMain(port: number, env: Record<string, string | null> = {}): RawServer {
  const output: string[] = [];
  const logDir = mkdtempSync(path.join(tmpdir(), 'sbm-rob-'));
  const merged: Record<string, string | undefined> = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_DIR: logDir,
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'info',
    SBM_EXIT_WITH_PARENT: '1',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: ROOT, env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => output.push(String(d)));
  child.stderr!.on('data', (d) => output.push(String(d)));
  return { child, out: () => output.join(''), baseUrl: `http://127.0.0.1:${port}` };
}

async function waitHealthy(srv: RawServer, deadlineMs = 45_000): Promise<any> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (srv.child.exitCode !== null) throw new Error(`server exited early (code ${srv.child.exitCode}):\n${srv.out()}`);
    try {
      const res = await fetch(`${srv.baseUrl}/healthz`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${srv.out()}`);
    await sleep(200);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(8_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function callWith(client: any, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const raw: any = await client.callTool({ name, arguments: args });
  const text = (raw.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  return { text, isError: Boolean(raw.isError) };
}

// F1: the browser process must not inherit the supervisor's secrets.
describe('F1: Obscura environment is allow-listed (secrets excluded)', () => {
  test('buildEnv drops AUTH_TOKEN, unrelated secrets and proxy credentials but keeps what Obscura needs', () => {
    const prior: Record<string, string | undefined> = {
      AUTH_TOKEN: process.env.AUTH_TOKEN,
      SBM_UNRELATED_SECRET: process.env.SBM_UNRELATED_SECRET,
      OBSCURA_PROXY: process.env.OBSCURA_PROXY,
    };
    process.env.AUTH_TOKEN = 'super-secret-auth-token';
    process.env.SBM_UNRELATED_SECRET = 'aws-key-should-not-leak';
    process.env.OBSCURA_PROXY = 'http://user:proxypass@127.0.0.1:9';
    try {
      const config = loadConfig(process.env);
      const noop = () => undefined;
      const fakeLog: any = { child: () => fakeLog, info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
      const env = new ObscuraProcess(config, fakeLog).buildEnv();

      assert.equal(env.AUTH_TOKEN, undefined, 'AUTH_TOKEN must not reach the browser');
      assert.equal(env.SBM_UNRELATED_SECRET, undefined, 'unrelated secrets must not reach the browser');
      assert.equal(env.OBSCURA_PROXY, undefined, 'proxy credentials go via --proxy, never the environment');
      const serialized = JSON.stringify(env);
      assert.equal(serialized.includes('super-secret-auth-token'), false);
      assert.equal(serialized.includes('aws-key-should-not-leak'), false);
      assert.equal(serialized.includes('proxypass'), false);

      assert.ok(env.PATH, 'PATH is forwarded so the binary can run');
      assert.equal(env.NO_COLOR, '1');
      assert.equal(env.OBSCURA_NAV_TIMEOUT_MS, String(config.obscura.navTimeoutMs));
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// F2 + F4: non-JSON POST bodies are rejected before they are read, and proxy creds are masked in status.
describe('F2/F4: non-JSON MCP bodies rejected; proxy credentials masked in status', { skip: FRESH }, () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ OBSCURA_PROXY: 'http://u:p@127.0.0.1:9', ALLOW_PRIVATE_NETWORK: '' });
  });
  after(async () => {
    await srv?.stop();
  });

  test('a non-JSON POST to /mcp is rejected with 415', async () => {
    const res = await fetch(`${srv.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    assert.equal(res.status, 415, await res.text().catch(() => ''));
  });

  test('a huge non-JSON POST does not crash the server; it stays healthy and serves MCP', async () => {
    const big = 'x'.repeat(50 * 1024 * 1024);
    let status = 0;
    try {
      const res = await fetch(`${srv.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: big });
      status = res.status;
    } catch {
      // the server may reset the connection while we are still streaming the oversized body
      status = -1;
    }
    assert.ok(status === 415 || status === 413 || status === -1, `unexpected status ${status}`);

    // The important guarantee: the process did not crash and orphan the browser.
    const health = await (await fetch(`${srv.baseUrl}/healthz`)).json();
    assert.equal(health.ok, true, 'server is still healthy after the oversized request');
    const { tools } = await srv.client.listTools();
    assert.ok(tools.length > 0, 'a normal MCP call still works');
  });

  test('F8: a percent-encoded token query parameter is redacted from the access log', async () => {
    const secret = 'leaky-token-value-99';
    await fetch(`${srv.baseUrl}/api/state?tok%65n=${secret}`);
    await sleep(400);
    const raw = srv.logDir ? readFileSync(path.join(srv.logDir, 'current.log'), 'utf8') : '';
    assert.equal(raw.includes(secret), false, 'the token value must not appear in the logs');
    assert.match(raw, /token=\[REDACTED\]/, 'the token parameter is logged as redacted');
  });

  test('F4: /healthz exposes Obscura args with the proxy password masked', async () => {
    const health = await (await fetch(`${srv.baseUrl}/healthz`)).json();
    assert.equal(health.obscura.mode, 'managed');
    const args = JSON.stringify(health.obscura.args);
    assert.equal(args.includes(':p@'), false, 'proxy password must be masked');
    assert.match(args, /u:\*\*\*@127\.0\.0\.1:9/, 'proxy is present but masked');
  });
});

// F3: the managed CDP port is randomised when not pinned, so it is not on a predictable default.
describe('F3: managed CDP port is a random free port when unset', { skip: FRESH }, () => {
  test('two servers started without OBSCURA_CDP_PORT use different ports, neither 9222', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const a = spawnMain(portA, { OBSCURA_CDP_PORT: null, ALLOW_PRIVATE_NETWORK: 'true' });
    const b = spawnMain(portB, { OBSCURA_CDP_PORT: null, ALLOW_PRIVATE_NETWORK: 'true' });
    try {
      const healthA = await waitHealthy(a);
      const healthB = await waitHealthy(b);
      const cdpA = new URL(healthA.obscura.cdpHttpUrl).port;
      const cdpB = new URL(healthB.obscura.cdpHttpUrl).port;
      assert.notEqual(cdpA, '9222', 'CDP port must not default to 9222');
      assert.notEqual(cdpB, '9222', 'CDP port must not default to 9222');
      assert.notEqual(cdpA, cdpB, 'two managed instances must pick different CDP ports');
    } finally {
      await stopChild(a.child);
      await stopChild(b.child);
    }
  });
});

// F6: too many concurrent sessions are refused instead of growing without bound.
describe('F6: MAX_SESSIONS caps concurrent MCP sessions', { skip: FRESH }, () => {
  let srv: TestServer;
  const extra: Array<{ client: any }> = [];
  before(async () => {
    // startTestServer opens one session already; with MAX_SESSIONS=3 two more succeed and the fourth fails.
    srv = await startTestServer({ MAX_SESSIONS: '3' });
  });
  after(async () => {
    for (const c of extra) await c.client.close().catch(() => undefined);
    await srv?.stop();
  });

  test('the session over the cap is refused while existing sessions keep working', async () => {
    const c2 = await connectClient(srv.mcpUrl, 'cap-2');
    extra.push(c2);
    const c3 = await connectClient(srv.mcpUrl, 'cap-3');
    extra.push(c3);
    await assert.rejects(connectClient(srv.mcpUrl, 'cap-4'), /capacity|503|error|refus/i, 'the 4th initialize is refused');
    assert.ok((await srv.client.listTools()).tools.length > 0, 'the harness session still works');
    assert.ok((await c2.client.listTools()).tools.length > 0, 'an existing extra session still works');
  });
});

// F7: routing is case-insensitive, so /MCP must still demand a bearer token, not the dashboard cookie.
describe('F7: /MCP (any case) requires a bearer token', { skip: FRESH }, () => {
  let srv: RawServer;
  const token = 'robustness-auth-token';
  before(async () => {
    srv = spawnMain(await freePort(), { AUTH_TOKEN: token });
    await waitHealthy(srv);
  });
  after(async () => {
    await stopChild(srv.child);
  });

  test('POST /MCP with only the dashboard cookie is rejected with 401', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const res = await fetch(`${srv.baseUrl}/MCP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `sbm_token=${encodeURIComponent(token)}` },
      body,
    });
    assert.equal(res.status, 401, 'the dashboard cookie must not authenticate an MCP request');

    // Control: a valid bearer token is accepted on the same upper-case path.
    const ok = await fetch(`${srv.baseUrl}/MCP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body,
    });
    assert.notEqual(ok.status, 401, 'a valid bearer token is accepted');
  });
});

// CR-4: a missing Obscura binary must fail startup fast, not after a 30s poll.
describe('CR-4: missing Obscura binary fails startup fast', { skip: FRESH }, () => {
  test('OBSCURA_BIN pointing at a nonexistent file exits non-zero within a few seconds', async () => {
    const srv = spawnMain(await freePort(), { OBSCURA_BIN: '/nonexistent/obscura-does-not-exist', OBSCURA_CDP_PORT: null });
    const start = Date.now();
    const code: number | null = await new Promise((r) => srv.child.once('exit', (c) => r(c)));
    const elapsed = Date.now() - start;
    assert.notEqual(code, 0, `expected a non-zero exit, got ${code}\n${srv.out()}`);
    assert.ok(elapsed < 15_000, `startup should fail fast, took ${elapsed} ms`);
  });
});

// CR-1 / CR-3: a failed HTTP bind must surface as a non-zero exit, not a false "ready".
describe('CR-1: a taken HTTP port fails startup instead of reporting ready', { skip: FRESH }, () => {
  test('starting a second server on an in-use PORT exits non-zero and never logs ready', async () => {
    const port = await freePort();
    const first = spawnMain(port, { OBSCURA_CDP_PORT: null });
    try {
      await waitHealthy(first);
      const second = spawnMain(port, { OBSCURA_CDP_PORT: null });
      const code: number | null = await new Promise((r) => second.child.once('exit', (c) => r(c)));
      assert.notEqual(code, 0, `second server on a taken port must exit non-zero, got ${code}\n${second.out()}`);
      assert.equal(second.out().includes('ready — MCP endpoint'), false, 'a server that failed to bind must not log ready');
    } finally {
      await stopChild(first.child);
    }
  });
});

// CR-6: after a browser reset every session is told once, not only the first to ask.
describe('CR-6: a browser reset notice reaches every session', { skip: FRESH }, () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv?.stop();
  });

  test('both sessions see the reset note after Obscura is killed', async () => {
    const b = await connectClient(srv.mcpUrl, 'reset-b');
    try {
      // Give each session an active tab so the disconnect counts as a reset (hadTabs === true).
      assert.equal((await srv.call('browser_evaluate', { expression: '1 + 1' })).isError, false);
      assert.equal((await callWith(b.client, 'browser_evaluate', { expression: '1 + 1' })).isError, false);

      const before = await (await fetch(`${srv.baseUrl}/healthz`)).json();
      const oldPid = before.obscura.pid as number;
      assert.ok(oldPid, 'obscura pid is exposed on /healthz');
      process.kill(oldPid, 'SIGKILL');

      // Wait for Obscura to be respawned (new pid) and healthy again.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const h = await (await fetch(`${srv.baseUrl}/healthz`)).json().catch(() => ({}));
        if (h.ok && h.obscura?.pid && h.obscura.pid !== oldPid) break;
        if (Date.now() > deadline) throw new Error('obscura did not restart in time');
        await sleep(250);
      }

      const a = await srv.call('browser_evaluate', { expression: '2 + 2' });
      const bAfter = await callWith(b.client, 'browser_evaluate', { expression: '2 + 2' });
      assert.match(a.text, /reset/i, `session A should be told about the reset:\n${a.text}`);
      assert.match(bAfter.text, /reset/i, `session B should also be told about the reset:\n${bAfter.text}`);
    } finally {
      await b.client.close().catch(() => undefined);
    }
  });
});

// CR-9: the idle reaper must not close a session that has a tool call in flight.
describe('CR-9: a running tool call is not reaped by the idle timeout', { skip: FRESH }, () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ SESSION_IDLE_TIMEOUT_MS: '2000' });
  });
  after(async () => {
    await srv?.stop();
  });

  test('a wait longer than the idle timeout still returns its result', async () => {
    // The reaper runs every ~5s; a 6s wait guarantees a tick lands mid-call while the session is idle.
    const res = await srv.call('browser_wait', { seconds: 6 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /Waited/, 'the wait completed and returned instead of being reaped');
  });
});
