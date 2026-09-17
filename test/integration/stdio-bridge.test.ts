import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, type ClientOptions } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = path.join(ROOT, 'src/stdio-bridge.ts');

interface Bridge {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
}

async function startBridge(url: string, name: string, env: Record<string, string> = {}, clientOptions?: ClientOptions): Promise<Bridge> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE, url],
    cwd: ROOT,
    env: { ...getDefaultEnvironment(), BRIDGE_LOG_LEVEL: 'debug', ...(process.env.AUTH_TOKEN ? { AUTH_TOKEN: process.env.AUTH_TOKEN } : {}), ...env },
    stderr: 'pipe',
  });
  const chunks: string[] = [];
  transport.stderr?.on('data', (d) => chunks.push(String(d)));
  const client = new Client({ name, version: '1.2.3' }, clientOptions);
  await client.connect(transport);
  return { client, transport, stderr: () => chunks.join('') };
}

async function state(srv: TestServer): Promise<any> {
  const headers: Record<string, string> = {};
  if (process.env.AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
  const res = await fetch(`${srv.baseUrl}/api/state`, { headers });
  assert.equal(res.status, 200);
  return res.json();
}

function text(result: any): string {
  return (result.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
}

/** The stdio bridge must be a transparent MCP proxy to the HTTP server. */
describe('stdio bridge', () => {
  let fx: FixtureServer;
  let srv: TestServer;
  let bridge: Bridge;

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
    bridge = await startBridge(srv.mcpUrl, 'bridge-test');
  });
  after(async () => {
    await bridge?.client.close().catch(() => undefined);
    await srv?.stop();
    await fx?.close();
  });

  test('forwards the handshake: server info, instructions and tools', async () => {
    const version = bridge.client.getServerVersion();
    assert.equal(version?.name, 'stealth-browser-mcp');
    assert.match(bridge.client.getInstructions() ?? '', /browser_snapshot/);
    const { tools } = await bridge.client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click']) assert.ok(names.includes(name), name);

    const s = await state(srv);
    const session = s.sessions.find((x: any) => x.client === 'bridge-test 1.2.3');
    assert.ok(session, `server sees the stdio client's own identity: ${JSON.stringify(s.sessions)}`);
    assert.match(bridge.stderr(), /connected to stealth-browser-mcp/);
  });

  test('calls browser tools through the bridge', async () => {
    const nav = await bridge.client.callTool({ name: 'browser_navigate', arguments: { url: `${fx.baseUrl}/index.html` } });
    assert.notEqual(nav.isError, true, text(nav));
    assert.match(text(nav), /Fixture Home/);

    const snap = await bridge.client.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.notEqual(snap.isError, true, text(snap));
    assert.match(text(snap), /Hello Fixture/);
    assert.match(text(snap), /ref=e\d+\s+button\s+"Click me"/);

    const bad = await bridge.client.callTool({ name: 'browser_navigate', arguments: { url: 'file:///etc/passwd' } });
    assert.equal(bad.isError, true, 'tool errors come back as isError results');

    const s = await state(srv);
    const calls = s.history.activity.filter((a: any) => a.client === 'bridge-test 1.2.3').map((a: any) => a.tool);
    assert.deepEqual(calls.slice(-3), ['browser_navigate', 'browser_snapshot', 'browser_navigate']);
  });

  test('parallel requests are all answered', async () => {
    const results = await Promise.all([
      bridge.client.listTools(),
      bridge.client.callTool({ name: 'browser_snapshot', arguments: { include_elements: false } }),
      bridge.client.ping(),
    ]);
    assert.ok(results[0].tools.length > 0);
    assert.match(text(results[1]), /Hello Fixture/);
  });

  test('re-establishes the session when the server forgets it', async () => {
    const before = (await state(srv)).sessions.find((x: any) => x.client === 'bridge-test 1.2.3');
    assert.ok(before);
    const headers: Record<string, string> = { 'mcp-session-id': before.id };
    if (process.env.AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
    const del = await fetch(srv.mcpUrl, { method: 'DELETE', headers });
    assert.ok(del.ok, `DELETE session: HTTP ${del.status}`);

    const snap = await bridge.client.callTool({ name: 'browser_snapshot', arguments: { include_elements: false } });
    assert.notEqual(snap.isError, true, text(snap));
    assert.match(text(snap), /Hello Fixture/);
    const after = (await state(srv)).sessions.find((x: any) => x.client === 'bridge-test 1.2.3');
    assert.ok(after, 'a new session exists');
    assert.notEqual(after.id, before.id);
    assert.match(bridge.stderr(), /new session/);
  });

  test('closing the stdio client ends the bridge and its HTTP session', async () => {
    const other = await startBridge(srv.mcpUrl, 'bridge-close-test');
    assert.ok((await state(srv)).sessions.some((x: any) => x.client === 'bridge-close-test 1.2.3'));
    const pid = other.transport.pid;
    assert.ok(pid);
    await other.client.close();
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'bridge process exited');
    const s = await state(srv);
    assert.equal(s.sessions.some((x: any) => x.client === 'bridge-close-test 1.2.3'), false, 'session was terminated with DELETE');
  });

  test('serves clients that negotiate the 2026-07-28 protocol', async () => {
    const modern = await startBridge(srv.mcpUrl, 'bridge-modern-test', {}, { versionNegotiation: { mode: 'auto' } });
    try {
      assert.equal(modern.client.getNegotiatedProtocolVersion?.(), '2026-07-28');
      const { tools } = await modern.client.listTools();
      assert.ok(tools.some((t) => t.name === 'browser_snapshot'));
      const snap = await modern.client.callTool({ name: 'browser_snapshot', arguments: { include_elements: false } });
      assert.notEqual(snap.isError, true, text(snap));
      assert.match(text(snap), /Hello Fixture/);
    } finally {
      await modern.client.close();
    }
  });

  test('reports an unreachable server as an error instead of hanging', async () => {
    const started = Date.now();
    await assert.rejects(
      startBridge('http://127.0.0.1:9/mcp', 'bridge-unreachable', { BRIDGE_CONNECT_TIMEOUT_MS: '1000' }),
      /Cannot reach the Stealth Browser MCP server/,
    );
    assert.ok(Date.now() - started < 15_000, 'fails fast');
  });

  test('answers requests that were sent before stdin ended (one-shot pipe)', async () => {
    const child = spawn(process.execPath, [BRIDGE, srv.mcpUrl], {
      cwd: ROOT,
      env: { ...process.env, BRIDGE_LOG_LEVEL: 'warn' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-pipe-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { include_elements: false } } },
    ];
    child.stdin.end(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 30_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0, `bridge exit code (stderr: ${stderr})`);
    const responses = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      responses.map((r) => r.id),
      [1, 2, 3],
      `responses on stdout: ${stdout.slice(0, 500)}`,
    );
    assert.ok(responses[1].result.tools.length > 0);
    assert.match(JSON.stringify(responses[2].result), /Hello Fixture/);
    const s = await state(srv);
    assert.equal(s.sessions.some((x: any) => x.client === 'bridge-pipe-test 1'), false, 'the HTTP session was terminated on exit');
  });

  test('returns an error instead of hanging when the server drops a call mid-response', async () => {
    // A stand-in server that accepts the call, opens the SSE response stream and then dies.
    const fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(req.method === 'DELETE' ? 200 : 405);
          return res.end();
        }
        const msg = JSON.parse(raw);
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'fake-session' });
          const result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } };
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        }
        if (msg.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        setTimeout(() => res.socket?.destroy(), 300);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/mcp`;
    const dropped = await startBridge(fakeUrl, 'bridge-drop-test');
    try {
      const started = Date.now();
      await assert.rejects(
        dropped.client.callTool({ name: 'browser_wait', arguments: { seconds: 10 } }, { timeout: 20_000 }),
        /closed the connection before answering tools\/call/,
      );
      assert.ok(Date.now() - started < 10_000, `answered after ${Date.now() - started} ms`);
    } finally {
      await dropped.client.close().catch(() => undefined);
      fake.closeAllConnections();
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });

  test('explains a missing AUTH_TOKEN', async () => {
    const guarded = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' }, id: null }));
      });
    });
    await new Promise<void>((r) => guarded.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(
        startBridge(`http://127.0.0.1:${(guarded.address() as AddressInfo).port}/mcp`, 'bridge-auth-test', { AUTH_TOKEN: '' }),
        /requires a token: set AUTH_TOKEN/,
      );
    } finally {
      guarded.closeAllConnections();
      await new Promise<void>((r) => guarded.close(() => r()));
    }
  });

  test('never writes logs to stdout', async () => {
    // Every stdout line was parsed as JSON-RPC by the client; a stray log line would surface as an error here.
    const errors: Error[] = [];
    const probe = await startBridge(srv.mcpUrl, 'bridge-stdout-test');
    probe.client.onerror = (err) => errors.push(err);
    await probe.client.listTools();
    await probe.client.close();
    assert.deepEqual(errors.map((e) => e.message), []);
    assert.match(probe.stderr(), /\[stealth-browser-bridge\]/);
  });
});
