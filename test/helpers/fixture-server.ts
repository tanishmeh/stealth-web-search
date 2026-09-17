import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/site');

export interface FixtureServer {
  /** Base URL as seen by the browser (may differ from the local bind address when the browser runs in Docker). */
  baseUrl: string;
  port: number;
  requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

/**
 * Local website used by integration tests. Static pages live in
 * test/fixtures/site; dynamic endpoints:
 *   /echo           renders method, query and body (form targets)
 *   /api/data       JSON {items:[...]}
 *   /slow?ms=N      responds after N ms
 *   /redirect?to=U  302 to U
 *   /status/N       responds with HTTP status N
 *   /set-cookie?name=&value=   sets a cookie and shows document.cookie (&httponly=1 adds HttpOnly, &reverse=1 stores the reversed value)
 *
 * FIXTURE_HOST overrides the host in baseUrl (e.g. host.docker.internal when
 * the server under test runs in a container).
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body, headers: req.headers });
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      const html = (status: number, markup: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
        res.end(markup);
      };
      try {
        if (url.pathname === '/echo') {
          const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
          return html(
            200,
            `<!doctype html><title>Echo</title><h1>Echo</h1><p id="method">${req.method}</p><p id="query">${escape(url.search)}</p><pre id="body">${escape(body)}</pre>`,
          );
        }
        if (url.pathname === '/api/data') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ items: ['alpha', 'beta', 'gamma'] }));
        }
        if (url.pathname === '/slow') {
          const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000), 60_000);
          await new Promise((r) => setTimeout(r, ms));
          return html(200, `<!doctype html><title>Slow</title><p>waited ${ms} ms</p>`);
        }
        if (url.pathname === '/redirect') {
          res.writeHead(302, { Location: url.searchParams.get('to') ?? '/index.html' });
          return res.end();
        }
        if (url.pathname.startsWith('/status/')) {
          const status = Number(url.pathname.split('/')[2]) || 500;
          return html(status, `<!doctype html><title>Status ${status}</title><h1>Status ${status}</h1>`);
        }
        if (url.pathname === '/set-cookie') {
          const name = url.searchParams.get('name') ?? 'fixture';
          // reverse=1 stores the reversed value, so a test can keep the real cookie value out of URLs
          const raw = url.searchParams.get('value') ?? '1';
          const value = url.searchParams.get('reverse') === '1' ? Array.from(raw).reverse().join('') : raw;
          return html(200, `<!doctype html><title>Cookie</title><p id="c"></p><script>document.getElementById('c').textContent=document.cookie</script>`, {
            'Set-Cookie': `${name}=${value}; Path=/${url.searchParams.get('httponly') === '1' ? '; HttpOnly' : ''}`,
          });
        }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const resolved = path.resolve(SITE, file);
        if (!resolved.startsWith(SITE)) return html(403, 'forbidden');
        const content = await readFile(resolved);
        const type = resolved.endsWith('.html') ? 'text/html; charset=utf-8' : resolved.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
      } catch {
        html(404, `<!doctype html><title>Not found</title><h1>Not found</h1>`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
  return {
    baseUrl: `http://${host}:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
