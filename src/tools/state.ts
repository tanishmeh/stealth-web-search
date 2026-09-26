import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import {
  activeOrigin,
  allCookies as jarCookies,
  applyStorage,
  browserSend as connectionSend,
  canonicalDomain,
  cookieParam,
  domainFromInput,
  httpUrl,
  isoTime,
  normalizeOrigin,
  nowSeconds,
  readActiveStorage,
  sortCookies,
  storageItems,
  toCookieOut,
  type CookieParam,
  type OriginState,
} from '../browser/storage-state.ts';
import { compactJson } from './format.ts';
import { DESTRUCTIVE_LOCAL, LOCAL_STATE, READ_ONLY, defineTool, textResult, type ToolContext } from './types.ts';

export { canonicalDomain, domainFromInput, type CookieOut } from '../browser/storage-state.ts';

// The cookie tools log their CDP calls as before (cookie values masked while LOG_REDACT_SECRETS=true);
// storage reads and writes are quiet while it is on. The helpers live in browser/storage-state.ts.
function browserSend<T>(ctx: ToolContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return connectionSend<T>(ctx.browser, method, params, { quiet: false });
}

function allCookies(ctx: ToolContext) {
  return jarCookies(ctx.browser, { quiet: false });
}

// ------------------------------------------------------------------ cookies

export const getCookies = defineTool({
  name: 'browser_get_cookies',
  sensitive: { result: true },
  title: 'Get cookies',
  group: 'state',
  description:
    'List cookies in the browser cookie jar (shared by all tabs), including HttpOnly cookies, as one JSON object per line. ' +
    'expires is a unix timestamp in seconds, or -1 for session cookies.',
  inputSchema: z.object({
    domain: z.string().optional().describe('Only cookies for this domain or its subdomains, e.g. "example.com"'),
    name: z.string().optional().describe('Only cookies with exactly this name'),
  }),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'Get cookies' },
  handler: async ({ domain, name }, ctx) => {
    let cookies = await allCookies(ctx);
    if (domain !== undefined && domain.trim() !== '') {
      const d = domainFromInput(domain);
      cookies = cookies.filter((c) => {
        const cd = canonicalDomain(c.domain);
        return cd === d || cd.endsWith(`.${d}`);
      });
    }
    if (name !== undefined && name !== '') cookies = cookies.filter((c) => c.name === name);
    if (cookies.length === 0) return textResult('No cookies.');
    return textResult(sortCookies(cookies).map((c) => JSON.stringify(toCookieOut(c))).join('\n'));
  },
});

export const setCookie = defineTool({
  name: 'browser_set_cookie',
  sensitive: { args: ['value'] },
  title: 'Set cookie',
  group: 'state',
  description:
    'Add or replace a cookie in the browser cookie jar (shared by all tabs), e.g. to reuse a session token instead of logging in. ' +
    'Give domain or url; by default the cookie is set for the current page\'s host.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Cookie name'),
    value: z.string().describe('Cookie value'),
    domain: z.string().optional().describe('Cookie domain, e.g. "example.com" (also valid for subdomains)'),
    url: z.string().optional().describe('URL whose host is used as the domain when domain is not given, e.g. "https://example.com"'),
    path: z.string().optional().describe('Cookie path (default "/")'),
    secure: z.boolean().optional().describe('Only send over HTTPS (default false)'),
    http_only: z.boolean().optional().describe('Hide from page JavaScript (document.cookie) (default false)'),
    same_site: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite policy (default "Lax")'),
    expires: z.number().optional().describe('Expiry as a unix timestamp in seconds (default: session cookie)'),
  }),
  annotations: { ...LOCAL_STATE, title: 'Set cookie' },
  handler: async ({ name, value, domain, url, path, secure, http_only, same_site, expires }, ctx) => {
    if (/[\s;=]/.test(name)) throw new ToolError('Cookie name must not contain spaces, ";" or "="');
    if (/[;\r\n]/.test(value)) throw new ToolError('Cookie value must not contain ";" or line breaks');
    let host: string;
    if (domain !== undefined && domain.trim() !== '') {
      host = domainFromInput(domain);
    } else if (url !== undefined && url.trim() !== '') {
      host = canonicalDomain(httpUrl(url, ctx.config, 'url').hostname);
    } else {
      const current = await activeOrigin(ctx.browser.activeTab);
      if (!current) throw new ToolError('Provide domain or url: the active tab is not on an http(s) page.');
      host = canonicalDomain(new URL(current.origin).hostname);
    }
    if (!host || !/^[a-z0-9.\-_[\]:]+$/i.test(host)) throw new ToolError(`Invalid cookie domain: ${JSON.stringify(domain ?? url)}`);
    const cookiePath = path !== undefined && path.trim() !== '' ? path.trim() : '/';
    if (!cookiePath.startsWith('/')) throw new ToolError('Cookie path must start with "/"');

    const params: Record<string, unknown> = { name, value, domain: host, path: cookiePath, secure: Boolean(secure), httpOnly: Boolean(http_only) };
    if (same_site) params.sameSite = same_site;
    let expired = false;
    if (expires !== undefined) {
      if (!Number.isFinite(expires)) throw new ToolError('expires must be a unix timestamp in seconds');
      // milliseconds are above 1e12 (every time after 2001); seconds stay below it until year 33658
      const seconds = Math.floor(expires > 1e12 ? expires / 1000 : expires);
      if (seconds > 0) {
        params.expires = seconds;
        expired = seconds <= nowSeconds();
      }
    }
    const res = await browserSend<{ success?: boolean }>(ctx, 'Network.setCookie', params);
    if (res.success === false) throw new ToolError(`The browser rejected cookie ${name} for ${host}${cookiePath}`);

    const stored = (await allCookies(ctx)).find(
      (c) => c.name === name && canonicalDomain(c.domain) === host && c.path === cookiePath && (expired || c.value === value),
    );
    if (expired) {
      if (stored) throw new ToolError(`Cookie ${name} for ${host}${cookiePath} has an expiry in the past but is still stored`);
      return textResult(`Cookie ${name} for ${host}${cookiePath} has an expiry in the past, so it was removed from the jar.`);
    }
    if (!stored) throw new ToolError(`Cookie ${name} for ${host}${cookiePath} could not be verified after setting it`);
    const flags = [stored.httpOnly ? 'HttpOnly' : '', stored.secure ? 'Secure' : '', `SameSite=${stored.sameSite || 'Lax'}`];
    // the engine keeps any expiry, even one past the range of a date
    const until = typeof stored.expires === 'number' && stored.expires > 0 ? (isoTime(stored.expires) ?? `at unix time ${stored.expires}`) : null;
    flags.push(until ? `expires ${until}` : 'session');
    return textResult(`Set cookie ${name} for ${host}${cookiePath} (${flags.filter(Boolean).join(', ')})`);
  },
});

export const clearCookies = defineTool({
  name: 'browser_clear_cookies',
  title: 'Clear cookies',
  group: 'state',
  description:
    'Delete every cookie from the browser cookie jar (all domains, all tabs), and unload the snapshots (saved sign-ins) loaded in this browser, ' +
    'so their site storage is no longer restored on page loads. The open page\'s localStorage is not changed.',
  inputSchema: z.object({}),
  annotations: { ...DESTRUCTIVE_LOCAL, title: 'Clear cookies' },
  handler: async (_args, ctx) => {
    const before = (await allCookies(ctx)).length;
    try {
      await browserSend(ctx, 'Network.clearBrowserCookies');
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      await browserSend(ctx, 'Storage.clearCookies');
    }
    let remaining = (await allCookies(ctx)).length;
    if (remaining > 0) {
      await browserSend(ctx, 'Storage.clearCookies');
      remaining = (await allCookies(ctx)).length;
      if (remaining > 0) throw new ToolError(`Could not clear cookies: ${remaining} cookie(s) remain`);
    }
    // the cookies loaded snapshots put here are gone: their markers and storage seed go too, so a
    // later sign-in to another account is neither mixed with their storage nor saved into them
    const unloaded = (await ctx.snapshots?.unloadAll(ctx.browser)) ?? [];
    const quoted = unloaded.map((n) => JSON.stringify(n)).join(', ');
    const note = !unloaded.length
      ? ''
      : unloaded.length === 1
        ? ` Snapshot ${quoted} is no longer loaded in this browser.`
        : ` Snapshots ${quoted} are no longer loaded in this browser.`;
    return textResult(`Cleared all cookies (${before} removed).${note}`);
  },
});

// ------------------------------------------------------------------ storage state

export const storageState = defineTool({
  name: 'browser_storage_state',
  sensitive: { result: true },
  title: 'Export storage state',
  group: 'state',
  description:
    'Export the session state as JSON: all cookies plus localStorage and sessionStorage of the active tab\'s origin. ' +
    'Save it and pass it to browser_set_storage_state later to restore a logged-in session without logging in again ' +
    '(cookie-based logins restore fully; Obscura keeps page storage only until the page navigates or reloads).',
  inputSchema: z.object({}),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'Export storage state' },
  handler: async (_args, ctx) => {
    const cookies = sortCookies(await allCookies(ctx)).map(toCookieOut);
    const origins: OriginState[] = [];
    const st = await readActiveStorage(ctx.browser.activeTab, { quiet: ctx.config.log.redactSecrets });
    if (st) origins.push(st);
    // compact but valid JSON: most cookies fit on one line, which saves tokens when the agent passes it back
    return textResult(compactJson({ cookies, origins }, 200));
  },
});

function listSkipped(lines: string[], reasons: string[], max = 10): void {
  for (const r of reasons.slice(0, max)) lines.push(`  - ${r}`);
  if (reasons.length > max) lines.push(`  - …and ${reasons.length - max} more`);
}

export const setStorageState = defineTool({
  name: 'browser_set_storage_state',
  sensitive: { args: ['state'] },
  title: 'Restore storage state',
  group: 'state',
  description:
    'Restore state exported by browser_storage_state: cookies are added to the shared cookie jar, and localStorage/sessionStorage ' +
    'entries are written for the origin the active tab is currently on (navigate there first; entries for other origins are reported as skipped). ' +
    'Obscura keeps page storage per page load, so restored storage lasts until the tab navigates or reloads; cookies persist.',
  inputSchema: z.object({
    state: z
      .union([
        z.looseObject({
          cookies: z.array(z.unknown()).optional().describe('Cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite}]'),
          origins: z.array(z.unknown()).optional().describe('Storage per origin: [{origin, localStorage: [{name, value}], sessionStorage: [{name, value}]}]'),
        }),
        z.string(),
      ])
      .describe('The JSON object returned by browser_storage_state: {cookies: [...], origins: [...]}'),
  }),
  annotations: { ...LOCAL_STATE, title: 'Restore storage state' },
  handler: async ({ state }, ctx) => {
    let parsed: unknown = state;
    if (typeof state === 'string') {
      try {
        parsed = JSON.parse(state);
      } catch {
        throw new ToolError('state must be the JSON object returned by browser_storage_state (the string given is not valid JSON)');
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ToolError('state must be an object like {cookies: [...], origins: [...]}');
    }
    const st = parsed as Record<string, unknown>;
    if (st.cookies !== undefined && !Array.isArray(st.cookies)) throw new ToolError('state.cookies must be an array');
    if (st.origins !== undefined && !Array.isArray(st.origins)) throw new ToolError('state.origins must be an array');
    const cookieEntries = (st.cookies as unknown[] | undefined) ?? [];
    const originEntries = (st.origins as unknown[] | undefined) ?? [];
    if (cookieEntries.length === 0 && originEntries.length === 0) throw new ToolError('state contains no cookies and no origins to restore');

    const lines: string[] = [];

    // cookies
    if (cookieEntries.length > 0) {
      const valid: CookieParam[] = [];
      const skipped: string[] = [];
      cookieEntries.forEach((entry, i) => {
        const res = cookieParam(entry, ctx.config);
        if (typeof res === 'string') skipped.push(`cookie #${i + 1} ${res}`);
        else valid.push(res);
      });
      let restored = 0;
      if (valid.length > 0) {
        await browserSend(ctx, 'Network.setCookies', { cookies: valid });
        const jar = await allCookies(ctx);
        for (const c of valid) {
          const found = jar.some((j) => j.name === c.name && canonicalDomain(j.domain) === c.domain && j.path === c.path && j.value === c.value);
          if (found) restored++;
          else skipped.push(`cookie ${JSON.stringify(c.name)} for ${c.domain}${c.path}: not accepted by the browser`);
        }
      }
      lines.push(`Cookies: restored ${restored} of ${cookieEntries.length}${skipped.length ? ` (skipped ${skipped.length})` : ''}.`);
      listSkipped(lines, skipped);
    }

    // storage
    if (originEntries.length > 0) {
      const current = await activeOrigin(ctx.browser.activeTab);
      let appliedAny = false;
      for (const [i, entry] of originEntries.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          lines.push(`Skipped origins[${i}]: not an object.`);
          continue;
        }
        const o = entry as Record<string, unknown>;
        const origin = typeof o.origin === 'string' ? normalizeOrigin(o.origin) : null;
        if (!origin) {
          lines.push(`Skipped origins[${i}]: ${typeof o.origin === 'string' ? `${JSON.stringify(o.origin)} is not an http(s) origin` : 'missing origin'}.`);
          continue;
        }
        const local = storageItems(o.localStorage, 'localStorage');
        const session = storageItems(o.sessionStorage, 'sessionStorage');
        const count = local.items.length + session.items.length;
        if (!current || current.origin !== origin) {
          const where = current ? `the active tab is on ${current.origin}` : 'the active tab is not on a web page';
          lines.push(
            `Skipped storage for ${origin} (${count} item(s)): ${where}. Navigate the active tab to ${origin}, then call browser_set_storage_state again.`,
          );
          continue;
        }
        const entries = [
          ...local.items.map((it) => ({ ...it, session: false })),
          ...session.items.map((it) => ({ ...it, session: true })),
        ];
        const res = await applyStorage(current.tab, entries, { quiet: ctx.config.log.redactSecrets });
        const skipped = [...local.skipped, ...session.skipped, ...(res.errors ?? [])];
        lines.push(
          `Storage for ${origin}: set ${local.items.length} localStorage and ${session.items.length} sessionStorage item(s)` +
            `${res.applied !== entries.length ? ` (${res.applied} succeeded)` : ''}${skipped.length ? `, skipped ${skipped.length}` : ''}.`,
        );
        listSkipped(lines, skipped);
        if (res.applied > 0) appliedAny = true;
      }
      if (appliedAny) lines.push('Note: restored storage is visible to the current page and is lost when this tab navigates or reloads.');
    }
    return textResult(lines.join('\n'));
  },
});

export default [getCookies, setCookie, clearCookies, storageState, setStorageState];
