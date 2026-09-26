import { randomBytes } from 'node:crypto';
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
  /** Sign-ins issued by POST /login, by session token: tests check these values never leak. */
  sessions: Map<string, { user: string; profile: string }>;
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
 *   /set-cookie?name=&value=   sets a cookie and shows document.cookie (&httponly=1 adds HttpOnly, &reverse=1 stores the reversed value,
 *                   &max_age=N and &expires=<HTTP date> make it persistent)
 *   /login          GET: a sign-in form (#user, #password, #signin). POST: signs in with a server-issued
 *                   session cookie (HttpOnly) and puts a random "profile" into localStorage (no secret in a URL)
 *   /account        #who says "Signed in as <user>" for a valid session cookie, else "Signed out"; #profile says
 *                   whether localStorage holds that session's profile ("profile: restored"), never the value
 *   /logout         clears the session cookie in this browser (the session stays valid on the server, so a
 *                   saved copy of the cookie still signs in)
 *
 * FIXTURE_HOST overrides the host in baseUrl (e.g. host.docker.internal when
 * the server under test runs in a container).
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  const sessions: FixtureServer['sessions'] = new Map();
  const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const sessionOf = (req: http.IncomingMessage) => {
    const token = /(?:^|;\s*)session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    return token ? sessions.get(token) : undefined;
  };
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
          const attrs = [
            url.searchParams.get('httponly') === '1' ? 'HttpOnly' : '',
            url.searchParams.has('max_age') ? `Max-Age=${url.searchParams.get('max_age')}` : '',
            url.searchParams.has('expires') ? `Expires=${url.searchParams.get('expires')}` : '',
          ].filter(Boolean);
          return html(200, `<!doctype html><title>Cookie</title><p id="c"></p><script>document.getElementById('c').textContent=document.cookie</script>`, {
            'Set-Cookie': [`${name}=${value}`, 'Path=/', ...attrs].join('; '),
          });
        }
        if (url.pathname === '/login' && req.method === 'POST') {
          const user = new URLSearchParams(body).get('user')?.trim();
          if (!user) return html(400, '<!doctype html><title>Sign in</title><p id="who">Missing user</p>');
          const token = `sess-${randomBytes(12).toString('hex')}`;
          const profile = `prof-${randomBytes(12).toString('hex')}`;
          sessions.set(token, { user, profile });
          // the profile goes into localStorage: site storage a saved sign-in must keep
          return html(
            200,
            `<!doctype html><title>Signed in</title><h1>Welcome</h1><p id="who">Signed in as ${escape(user)}</p><script>localStorage.setItem('profile', ${JSON.stringify(profile)})</script>`,
            { 'Set-Cookie': `session=${token}; Path=/; HttpOnly` },
          );
        }
        if (url.pathname === '/login') {
          return html(
            200,
            '<!doctype html><title>Sign in</title><h1>Sign in</h1><form action="/login" method="post">' +
              '<label>User <input id="user" name="user"></label><label>Password <input id="password" name="password" type="password"></label>' +
              '<button id="signin" type="submit">Sign in</button></form>',
          );
        }
        if (url.pathname === '/account') {
          const session = sessionOf(req);
          // the page tells whether the profile is there, never its value: page text reaches the logs
          return html(
            200,
            `<!doctype html><title>Account</title><h1>Account</h1><p id="who">${session ? `Signed in as ${escape(session.user)}` : 'Signed out'}</p><p id="profile"></p>` +
              `<script>var v = localStorage.getItem('profile'); var want = ${JSON.stringify(session?.profile ?? null)};` +
              `document.getElementById('profile').textContent = v === null ? 'profile: none' : v === want ? 'profile: restored' : 'profile: other';</script>`,
          );
        }
        if (url.pathname === '/logout') {
          return html(200, '<!doctype html><title>Signed out</title><p id="who">Signed out</p>', { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
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
    sessions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
