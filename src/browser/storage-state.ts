import { CdpError } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import { normalizeUrl } from '../tools/navigation.ts';
import type { Browser } from './browser.ts';
import { ToolError } from './errors.ts';
import { APPLY_STORAGE, STORAGE_STATE } from './scripts.ts';
import type { Tab } from './tab.ts';

/**
 * Cookie and site-storage capture and restore, shared by the state tools (browser_get_cookies,
 * browser_storage_state, …) and saved snapshots. Callers choose `quiet` explicitly: a quiet CDP call
 * logs neither its parameters nor its result (snapshot code always passes quiet: true).
 */

/** Cookie as reported by Obscura's Network.getAllCookies. */
export interface CdpCookie {
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

export interface StorageItem {
  name: string;
  value: string;
}

export interface OriginState {
  origin: string;
  localStorage: StorageItem[];
  sessionStorage: StorageItem[];
}

/** A cookie ready for Network.setCookie(s). */
export interface CookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires?: number;
}

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' } as const;

/**
 * Cookies live in the browser-wide cookie jar that every tab shares, so the commands go to the
 * connection itself (no page session). This also avoids touching background tabs, which can reset
 * their JS state in Obscura v0.2.2.
 */
export async function browserSend<T>(browser: Browser, method: string, params: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<T> {
  const conn = await browser.connection();
  try {
    return await conn.send<T>(method, params, { quiet: opts.quiet });
  } catch (err) {
    if (err instanceof CdpError) throw new ToolError(`${method} failed: ${err.message}`);
    throw err;
  }
}

export async function allCookies(browser: Browser, opts: { quiet?: boolean } = {}): Promise<CdpCookie[]> {
  const res = await browserSend<{ cookies?: CdpCookie[] }>(browser, 'Network.getAllCookies', {}, opts);
  return res.cookies ?? [];
}

export function canonicalDomain(domain: string): string {
  return domain.trim().replace(/^\.+/, '').toLowerCase();
}

export function toCookieOut(c: CdpCookie): CookieOut {
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

export function sortCookies<T extends { domain: string; path: string; name: string }>(cookies: T[]): T[] {
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

export function httpUrl(input: string, config: Config, what: string): URL {
  const url = new URL(normalizeUrl(input, config));
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

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Longest cookie lifetime kept (400 days, the cap browsers apply). Obscura keeps whatever a site asks
 * for, e.g. "Expires=31 Dec 9999" or a Max-Age past the range of a JavaScript date.
 */
export const MAX_COOKIE_AGE_SECONDS = 400 * 86_400;

/** An expiry (unix seconds) no later than MAX_COOKIE_AGE_SECONDS from now. */
export function clampExpiry(seconds: number, now = nowSeconds()): number {
  return Math.min(seconds, now + MAX_COOKIE_AGE_SECONDS);
}

/** ISO time of a unix time in seconds, or null when a date cannot hold it (toISOString would throw). */
export function isoTime(seconds: number): string | null {
  const d = new Date(seconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The active tab's http(s) origin, or null when it has none (blank tab, data: URL, no tab). */
export async function activeOrigin(tab: Tab | null): Promise<{ tab: Tab; origin: string } | null> {
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

/**
 * Validate one exported cookie (ours, Playwright's, or Obscura's legacy http_only/same_site keys).
 * The reason for a refusal names the cookie: snapshot code reports refusals by domain and count only.
 * `seconds`: expires is known to be in seconds (a saved snapshot); otherwise a value above 1e12 is
 * read as milliseconds (every millisecond time after 2001; seconds stay below it until year 33658).
 * Expiries are kept at most MAX_COOKIE_AGE_SECONDS ahead.
 */
export function cookieParam(entry: unknown, config: Config, opts: { seconds?: boolean } = {}): CookieParam | string {
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
      domain = canonicalDomain(httpUrl(c.url, config, 'url').hostname);
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
    const seconds = Math.floor(!opts.seconds && raw > 1e12 ? raw / 1000 : raw);
    if (seconds > 0) {
      const now = nowSeconds();
      if (seconds <= now) return `${label}: expired at ${new Date(seconds * 1000).toISOString()}`;
      out.expires = clampExpiry(seconds, now);
    }
  }
  return out;
}

/** Accept [{name, value}], [[name, value]] (Obscura's legacy export) or {name: value}. */
export function storageItems(input: unknown, kind: string): { items: StorageItem[]; skipped: string[] } {
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

/** An http(s) origin ("https://example.com"), or null. */
export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** localStorage and sessionStorage of the active tab's http(s) origin, or null when it is on no web page. */
export async function readActiveStorage(tab: Tab | null, opts: { quiet: boolean }): Promise<OriginState | null> {
  const current = await activeOrigin(tab);
  if (!current) return null;
  const st = await current.tab.callFunction<OriginState>(STORAGE_STATE, [], { quiet: opts.quiet });
  if (!st || !st.origin || st.origin === 'null') return null;
  return { origin: st.origin, localStorage: st.localStorage ?? [], sessionStorage: st.sessionStorage ?? [] };
}

/** Write storage items into the tab's current page (lost when it navigates or reloads). */
export async function applyStorage(
  tab: Tab,
  entries: Array<StorageItem & { session: boolean }>,
  opts: { quiet: boolean },
): Promise<{ applied: number; errors: string[] }> {
  if (!entries.length) return { applied: 0, errors: [] };
  const res = await tab.callFunction<{ applied: number; errors: string[] }>(APPLY_STORAGE, [entries], { quiet: opts.quiet });
  return { applied: res?.applied ?? 0, errors: res?.errors ?? [] };
}
