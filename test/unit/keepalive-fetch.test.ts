import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Agent } from 'undici';
import { hasSlowKeepAlive, keepAliveFetch, type FetchFn } from '../../src/util/keepalive-fetch.ts';

describe('hasSlowKeepAlive', () => {
  test('matches only the undici releases that wait a timer tick before reusing a keep-alive socket', () => {
    for (const v of ['7.28.0', '7.29.0']) assert.equal(hasSlowKeepAlive(v), true, v);
    for (const v of ['7.25.0', '7.27.9', '7.29.1', '7.30.0', '8.10.2', '6.21.0', '', 'garbage', '7.28.0-pre', undefined]) {
      assert.equal(hasSlowKeepAlive(v), false, String(v));
    }
  });
});

describe('keepAliveFetch', () => {
  const recorder = () => {
    const calls: { input: string | URL; init?: RequestInit }[] = [];
    const fetch: FetchFn = async (input, init) => {
      calls.push({ input, init });
      return new Response('ok');
    };
    return { calls, fetch };
  };

  test('is not used on Node versions whose undici reuses sockets at once', () => {
    assert.equal(keepAliveFetch({ undiciVersion: '7.29.1' }), undefined);
    assert.equal(keepAliveFetch({ undiciVersion: '8.10.2' }), undefined);
  });

  test('sends requests unchanged until loaded, then through its own undici Agent', async () => {
    const base = recorder();
    const ka = keepAliveFetch({ undiciVersion: '7.28.0', fetch: base.fetch, globalDispatcher: () => undefined });
    assert.ok(ka);
    const init: RequestInit = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } };
    await ka.fetch('http://127.0.0.1:1/mcp', init);
    assert.equal(base.calls[0].init, init, 'before load the request is passed through as is');

    const loading = ka.load();
    assert.equal(ka.load(), loading, 'loads once');
    assert.equal(await loading, true);
    await ka.fetch('http://127.0.0.1:1/mcp', init);
    const sent = base.calls[1].init as RequestInit & { dispatcher?: unknown };
    assert.ok(sent.dispatcher instanceof Agent, 'an Agent from the undici package');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.body, '{}');
    assert.deepEqual(sent.headers, { 'content-type': 'application/json' });
    assert.equal((init as any).dispatcher, undefined, "the caller's init is not modified");
    await ka.fetch('http://127.0.0.1:1/mcp');
    assert.equal((base.calls[2].init as any).dispatcher, sent.dispatcher, 'one Agent for every request');
  });

  test("keeps a proxy or custom dispatcher that Node or the user installed", async () => {
    // Node creates its default dispatcher on the first fetch: one that exists before was installed on purpose
    class EnvHttpProxyAgent {}
    assert.equal(keepAliveFetch({ undiciVersion: '7.29.0', globalDispatcher: () => new EnvHttpProxyAgent() }), undefined);
    // also a plain Agent, e.g. one with custom TLS options set up with --import
    const custom = new Agent({ connect: { rejectUnauthorized: false } });
    try {
      assert.equal(keepAliveFetch({ undiciVersion: '7.28.0', globalDispatcher: () => custom }), undefined);
    } finally {
      await custom.close();
    }
  });

  test('keeps a dispatcher installed after it was created, before it loads', async () => {
    class EnvHttpProxyAgent {}
    let current: unknown;
    const base = recorder();
    const ka = keepAliveFetch({ undiciVersion: '7.29.0', fetch: base.fetch, globalDispatcher: () => current });
    assert.ok(ka);
    current = new EnvHttpProxyAgent();
    assert.equal(await ka.load(), false);
    await ka.fetch('http://127.0.0.1:1/mcp', { method: 'GET' });
    assert.equal((base.calls[0].init as any).dispatcher, undefined);
  });

  describe('over a real keep-alive connection', () => {
    let server: http.Server;
    let url: string;
    const connections: unknown[] = [];

    before(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message\ndata: {"n":1}\n\n'); // then stays open until the client aborts
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => (body += d));
        req.on('end', () => res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null })));
      });
      server.on('connection', (socket) => connections.push(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // importing undici above installed its default dispatcher in this process, as Node does on the
    // first fetch; the bridge creates its keepAliveFetch() before either happens
    const beforeFirstFetch = () => undefined;

    test('answers sequential requests on one reused connection, streams, and aborts', async () => {
      const ka = keepAliveFetch({ undiciVersion: '7.28.0', globalDispatcher: beforeFirstFetch });
      assert.ok(ka);
      assert.equal(await ka.load(), true);
      const post = async (i: number) => {
        const res = await ka.fetch(`${url}/mcp`, { method: 'POST', body: `{"i":${i}}`, headers: { authorization: 'Bearer t' } });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { method: 'POST', body: `{"i":${i}}`, auth: 'Bearer t' });
      };
      // undici (bundled or not) opens a second connection for the second request, then keeps it
      await post(0);
      await post(1);
      const opened = connections.length;
      for (let i = 2; i < 22; i++) await post(i);
      assert.equal(connections.length, opened, 'keep-alive: the connection is reused');

      const controller = new AbortController();
      const stream = await ka.fetch(`${url}/stream`, { signal: controller.signal });
      const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
      assert.match((await reader.read()).value ?? '', /data: \{"n":1\}/);
      controller.abort();
      await assert.rejects(reader.read(), { name: 'AbortError' });
    });

    test('removes the timer wait of the bundled undici (only where Node bundles an affected undici)', { skip: !hasSlowKeepAlive(process.versions.undici) }, async () => {
      const ka = keepAliveFetch({ globalDispatcher: beforeFirstFetch });
      assert.ok(ka);
      assert.equal(await ka.load(), true);
      const p50 = async (fn: FetchFn) => {
        for (let i = 0; i < 50; i++) await (await fn(`${url}/mcp`)).text();
        const times: number[] = [];
        for (let i = 0; i < 200; i++) {
          const start = performance.now();
          await (await fn(`${url}/mcp`)).text();
          times.push(performance.now() - start);
        }
        return times.sort((a, b) => a - b)[100];
      };
      const plain = await p50((input, init) => fetch(input, init));
      const fixed = await p50(ka.fetch);
      // about 1.5 ms vs 0.06 ms on an idle machine; a wide margin keeps this stable under load
      assert.ok(fixed * 3 < plain, `p50 with the fix ${fixed.toFixed(3)} ms, without ${plain.toFixed(3)} ms`);
    });
  });
});
