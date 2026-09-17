import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { APPLY_STORAGE, STORAGE_STATE } from '../browser/scripts.ts';
import type { Tab } from '../browser/tab.ts';
import { CdpError } from '../cdp/client.ts';
import { compactJson } from './format.ts';
import { normalizeUrl } from './navigation.ts';
import { DESTRUCTIVE_LOCAL, LOCAL_STATE, READ_ONLY, defineTool, textResult, type ToolContext } from './types.ts';

/** Cookie as reported by Obscura's Network.getAllCookies. */
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: string;
}

/** Exported cookie shape (same as Playwright's storageState cookies; expires -1 = session cookie). */
export interface CookieOut {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

interface StorageItem {
  name: string;
  value: string;
}

interface OriginState {
  origin: string;
  localStorage: StorageItem[];
  sessionStorage: StorageItem[];
}

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' } as const;

/**
 * Cookies live in the browser-wide cookie jar that every tab shares, so the
 * commands go to the connection itself (no page session). This also avoids
 * touching background tabs, which can reset their JS state in Obscura v0.2.2.
 */
async function browserSend<T>(ctx: ToolContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const conn = await ctx.browser.connection();
  try {
    return await conn.send<T>(method, params);
  } catch (err) {
    if (err instanceof CdpError) throw new ToolError(`${method} failed: ${err.message}`);
    throw err;
  }
}

async function allCookies(ctx: ToolContext): Promise<CdpCookie[]> {
  const res = await browserSend<{ cookies?: CdpCookie[] }>(ctx, 'Network.getAllCookies');
  return res.cookies ?? [];
}

export function canonicalDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, '').toLowerCase();
}

function toCookieOut(c: CdpCookie): CookieOut {
  const session = c.session === true || typeof c.expires !== 'number' || c.expires <= 0;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: session ? -1 : Math.round(c.expires),
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: c.sameSite || 'Lax',
  };
}

function sortCookies(cookies: CdpCookie[]): CdpCookie[] {
  return [...cookies].sort(
    (a, b) => canonicalDomain(a.domain).localeCompare(canonicalDomain(b.domain)) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
}

/** Domain input may be a bare domain, ".domain", "host:port", "[ipv6]" or a URL. */
export function domainFromInput(input: string): string {
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return canonicalDomain(new URL(raw).hostname);
    } catch {
      // fall through
    }
  }
  const ipv6 = /^\[[0-9a-f:.]+\]/i.exec(raw);
  if (ipv6) return ipv6[0].toLowerCase();
  return canonicalDomain(raw.replace(/[/:?#].*$/, ''));
}

function httpUrl(input: string, ctx: ToolContext, what: string): URL {
  const url = new URL(normalizeUrl(input, ctx.config));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(`${what} must be an http(s) URL, got ${url.protocol}`);
  return url;
}

/** SameSite as Strict/Lax/None; also accepts browser-extension exports ("no_restriction", "unspecified"). */
function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === 'unspecified') return undefined;
  if (key === 'no_restriction') return 'None';
  return SAME_SITE[key as keyof typeof SAME_SITE] ?? null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The active tab's http(s) origin, or null when it has none (blank tab, data: URL, no tab). */
async function activeOrigin(tab: Tab | null): Promise<{ tab: Tab; origin: string } | null> {
  if (!tab || tab.closed) return null;
  let href: string;
  try {
    href = (await tab.pageInfo()).url;
  } catch {
    href = tab.url;
  }
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { tab, origin: u.origin };
  } catch {
    return null;
  }
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
      host = canonicalDomain(httpUrl(url, ctx, 'url').hostname);
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
      const seconds = Math.floor(expires > 1e11 ? expires / 1000 : expires);
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
    flags.push(typeof stored.expires === 'number' && stored.expires > 0 ? `expires ${new Date(stored.expires * 1000).toISOString()}` : 'session');
    return textResult(`Set cookie ${name} for ${host}${cookiePath} (${flags.filter(Boolean).join(', ')})`);
  },
});

export const clearCookies = defineTool({
  name: 'browser_clear_cookies',
  title: 'Clear cookies',
  group: 'state',
  description: 'Delete every cookie from the browser cookie jar (all domains, all tabs). Page localStorage is not affected.',
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
    return textResult(`Cleared all cookies (${before} removed).`);
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
    const current = await activeOrigin(ctx.browser.activeTab);
    if (current) {
      const st = await current.tab.callFunction<OriginState>(STORAGE_STATE, [], { quiet: ctx.config.log.redactSecrets });
      if (st && st.origin && st.origin !== 'null') {
        origins.push({ origin: st.origin, localStorage: st.localStorage ?? [], sessionStorage: st.sessionStorage ?? [] });
      }
    }
    // compact but valid JSON: most cookies fit on one line, which saves tokens when the agent passes it back
    return textResult(compactJson({ cookies, origins }, 200));
  },
});

interface CookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires?: number;
}

/** Validate one exported cookie (ours, Playwright's, or Obscura's legacy http_only/same_site keys). */
function cookieParam(entry: unknown, ctx: ToolContext): CookieParam | string {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  const c = entry as Record<string, unknown>;
  if (typeof c.name !== 'string' || c.name === '') return 'missing name';
  const label = JSON.stringify(c.name);
  let value: string;
  if (typeof c.value === 'string') value = c.value;
  else if (typeof c.value === 'number' || typeof c.value === 'boolean') value = String(c.value);
  else return `${label}: missing value`;

  let domain = '';
  if (typeof c.domain === 'string' && c.domain.trim() !== '') domain = domainFromInput(c.domain);
  else if (typeof c.url === 'string' && c.url.trim() !== '') {
    try {
      domain = canonicalDomain(httpUrl(c.url, ctx, 'url').hostname);
    } catch (err) {
      return `${label}: ${(err as Error).message}`;
    }
  }
  if (!domain) return `${label}: missing domain (or url)`;

  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/';
  const httpOnly = c.httpOnly ?? c.http_only;
  const sameSite = normalizeSameSite(c.sameSite ?? c.same_site);
  if (sameSite === null) return `${label}: invalid sameSite ${JSON.stringify(c.sameSite ?? c.same_site)} (use Strict, Lax or None)`;
  const out: CookieParam = { name: c.name, value, domain, path, secure: c.secure === true, httpOnly: httpOnly === true };
  if (sameSite) out.sameSite = sameSite;

  // chrome.cookies-style exports use expirationDate (seconds, fractional) and session: true
  const expiresInput = c.session === true ? undefined : (c.expires ?? c.expirationDate);
  if (expiresInput !== undefined && expiresInput !== null) {
    const raw = typeof expiresInput === 'string' && expiresInput.trim() !== '' ? Number(expiresInput) : expiresInput;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return `${label}: invalid expires ${JSON.stringify(expiresInput)}`;
    const seconds = Math.floor(raw > 1e11 ? raw / 1000 : raw);
    if (seconds > 0) {
      if (seconds <= nowSeconds()) return `${label}: expired at ${new Date(seconds * 1000).toISOString()}`;
      out.expires = seconds;
    }
  }
  return out;
}

/** Accept [{name, value}], [[name, value]] (Obscura's legacy export) or {name: value}. */
function storageItems(input: unknown, kind: string): { items: StorageItem[]; skipped: string[] } {
  const items: StorageItem[] = [];
  const skipped: string[] = [];
  if (input === undefined || input === null) return { items, skipped };
  // numbers/booleans/objects are stored as their JSON text; null or a missing value is skipped
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : JSON.stringify(v));
  if (Array.isArray(input)) {
    input.forEach((entry, i) => {
      let name: unknown;
      let value: unknown;
      if (Array.isArray(entry)) [name, value] = entry;
      else if (entry && typeof entry === 'object') ({ name, value } = entry as Record<string, unknown>);
      const v = str(value);
      if (typeof name !== 'string' || v === undefined) skipped.push(`${kind}[${i}]: expected {name, value}`);
      else items.push({ name, value: v });
    });
  } else if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      const v = str(value);
      if (v === undefined) skipped.push(`${kind}.${name}: missing value`);
      else items.push({ name, value: v });
    }
  } else {
    skipped.push(`${kind}: expected an array of {name, value}`);
  }
  return { items, skipped };
}

function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

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
        const res = cookieParam(entry, ctx);
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
        const res = entries.length
          ? await current.tab.callFunction<{ applied: number; errors: string[] }>(APPLY_STORAGE, [entries], { quiet: ctx.config.log.redactSecrets })
          : { applied: 0, errors: [] };
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
