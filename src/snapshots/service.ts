import { EventEmitter } from 'node:events';
import type { Browser, SeedEntry } from '../browser/browser.ts';
import { ToolError } from '../browser/errors.ts';
import type { BrowserRegistry } from '../browser/registry.ts';
import {
  activeOrigin,
  allCookies,
  applyStorage,
  canonicalDomain,
  cookieParam,
  domainFromInput,
  normalizeOrigin,
  nowSeconds,
  readActiveStorage,
  sortCookies,
  storageItems,
  toCookieOut,
  type CdpCookie,
  type CookieOut,
  type CookieParam,
  type OriginState,
} from '../browser/storage-state.ts';
import { CdpError, type CdpConnection } from '../cdp/client.ts';
import type { Config } from '../config.ts';
import { MAIN_BROWSER, type Hub } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import {
  SnapshotError,
  SnapshotNotFoundError,
  SnapshotStore,
  normalizeSnapshotName,
  type SnapshotActor,
  type SnapshotListing,
  type SnapshotMeta,
} from './store.ts';

/**
 * Saved sign-ins ("snapshots"): capture a browser's cookies and site storage for chosen sites into
 * the store, and apply them to a browser (the main one, or a sub-agent's private one). Every CDP call
 * here is quiet (never logged), and results carry domains and counts only, never cookie names or values.
 * The service keeps the metadata list in memory so the dashboard gets it at once, and publishes the
 * hub event 'snapshots' on every store change and whenever a browser loads or loses one.
 */

/** A snapshot as tools, the dashboard API and the hub show it: allowlisted metadata only. */
export interface SnapshotView {
  name: string;
  description?: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
  created_by?: { client?: string; run_id?: string };
  updated_by?: { client?: string; run_id?: string };
  domains?: string[];
  cookie_count?: number;
  session_cookie_count?: number;
  cookie_domains?: string[];
  expired_count?: number;
  /** Earliest expiry of a cookie that has not expired yet (ISO), or null. */
  next_expiry?: string | null;
  origins?: Array<{ origin: string; local_storage: number; session_storage: number }>;
  loads?: number;
  last_loaded_at?: string | null;
  encrypted?: boolean;
  bytes?: number;
  /** The metadata may be out of date (a write was cut off after the state was saved). */
  stale?: boolean;
  /** Saved state without valid metadata, or metadata without a saved state: it can only be deleted. */
  incomplete?: boolean;
  /** Browsers (ids) where it is loaded, and where it is the active one. */
  loaded_in: string[];
  active_in: string[];
}

/** GET /api/snapshots and the hub 'snapshots' event. */
export interface SnapshotsPayload {
  snapshots: SnapshotView[];
  dir: string;
  /** SNAPSHOTS_KEY is set: saved states are encrypted. */
  encrypted: boolean;
  unencrypted_count: number;
}

export type SaveAction = 'created' | 'refreshed' | 'replaced';

export interface SaveOutcome {
  meta: SnapshotMeta;
  action: SaveAction;
  /** Cookies captured, by domain. */
  cookieDomains: string[];
  /** The site whose storage was captured (the active tab's), or null. */
  storageOrigin: string | null;
}

export interface ApplyOutcome {
  meta: SnapshotMeta;
  restored: number;
  total: number;
  /** Cookies not restored, by domain: expired, or refused by the browser. */
  expired: Map<string, number>;
  refused: Map<string, number>;
  /** Origins whose storage is restored on every page load. */
  storageOrigins: string[];
  /** The active tab was on one of them and got its storage right away. */
  appliedNow: boolean;
}

/** A capture into a snapshot that changed after this browser loaded it. */
export class SnapshotConflictError extends SnapshotError {
  readonly current: SnapshotMeta;
  constructor(message: string, current: SnapshotMeta) {
    super(message);
    this.current = current;
  }
}

/** A capture with no unexpired cookie for the snapshot's sites (signed out, or another site). */
export class SnapshotEmptyError extends SnapshotError {}

/** The site of a URL's host without a leading "www." (the default domain filter). */
export function siteOfHost(hostname: string): string {
  return canonicalDomain(hostname).replace(/^www\./, '');
}

/**
 * Whether a cookie (or storage) domain belongs to the filter: the domain itself, its subdomains, and
 * the parent-domain cookies a browser sends to it (www.example.com keeps example.com cookies).
 */
export function inScope(domain: string, filter: string[]): boolean {
  const cd = canonicalDomain(domain);
  return filter.some((d) => d === '*' || cd === d || cd.endsWith(`.${d}`) || (d.endsWith(`.${cd}`) && cd.includes('.')));
}

function originInScope(origin: string, filter: string[]): boolean {
  try {
    return inScope(new URL(origin).hostname, filter);
  } catch {
    return false;
  }
}

/** Domain filter entries: sites such as "example.com" (URLs and "www." hosts accepted); ["*"] is every cookie. */
export function normalizeFilter(domains: string[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const t = raw.trim();
    if (t === '*') return ['*'];
    const d = domainFromInput(t);
    if (!d || !/^[a-z0-9.\-_[\]:]+$/i.test(d)) throw new SnapshotError(`Invalid domain ${JSON.stringify(raw.slice(0, 100))}: give a site such as "example.com"`);
    out.add(d);
  }
  if (!out.size) throw new SnapshotError('domains is empty: give sites such as ["example.com"], or leave it out to save the site of the active tab');
  return [...out].sort();
}

/** "amazon.com", "amazon.com, amazon.de and 3 more", "every site". */
export function domainsText(domains: string[], max = 3): string {
  if (domains.includes('*')) return 'every site';
  if (!domains.length) return 'no site';
  return domains.length > max ? `${domains.slice(0, max).join(', ')} and ${domains.length - max} more` : domains.join(', ');
}

/** Who saved a snapshot, for tool text: "run r1a2b3c", the client's name, or "another client". */
export function actorText(a: SnapshotActor | undefined): string {
  if (a?.runId) return `sub-agent run ${a.runId}`;
  return a?.client ?? 'another client';
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Connection-level CDP call that is never logged (cookie and storage values). */
async function quietSend<T>(conn: CdpConnection, method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return await conn.send<T>(method, params, { quiet: true });
  } catch (err) {
    if (err instanceof CdpError) throw new ToolError(`${method} failed: ${err.message}`);
    throw err;
  }
}

/**
 * The storage seed: one script that runs before a page's own scripts on every page load of this
 * connection and writes the saved storage of that page's origin. Obscura keeps page storage only for
 * one page load, so this is what makes restored storage last. The values are embedded as JSON (this
 * CDP method takes no arguments); the script is only ever sent quietly.
 */
function seedSource(seed: Map<string, SeedEntry>): string {
  const data: Record<string, [string[][], string[][]]> = {};
  for (const [origin, e] of seed) data[origin] = [e.localStorage.map((i) => [i.name, i.value]), e.sessionStorage.map((i) => [i.name, i.value])];
  return `(function () {
  var seed = ${JSON.stringify(data)};
  var s = Object.prototype.hasOwnProperty.call(seed, location.origin) ? seed[location.origin] : null;
  if (!s) return;
  function put(store, items) { try { for (var i = 0; i < items.length; i++) store.setItem(items[i][0], items[i][1]); } catch (e) {} }
  put(localStorage, s[0]);
  put(sessionStorage, s[1]);
})();`;
}

export class SnapshotService extends EventEmitter {
  readonly store: SnapshotStore;
  private readonly config: Config;
  private readonly hub: Hub;
  private readonly log: Logger;
  private readonly registry: BrowserRegistry;
  private listing: SnapshotListing = { snapshots: [], incomplete: [] };
  private readonly tracked = new WeakSet<Browser>();
  private publishQueued = false;
  /** Deletions so far, and the count at each name's latest deletion: a load or save that overlapped one marks nothing. */
  private deletions = 0;
  private readonly deletedAt = new Map<string, number>();

  constructor(deps: { config: Config; log: Logger; hub: Hub }, registry: BrowserRegistry) {
    super();
    this.config = deps.config;
    this.hub = deps.hub;
    this.log = deps.log.child({ component: 'snapshots' });
    this.registry = registry;
    this.store = new SnapshotStore(deps.config.snapshots.dir, deps.config.snapshots.key, this.log);
    const main = registry.browser(MAIN_BROWSER);
    if (main) this.track(main);
  }

  /** Startup: check the directory is writable, remove leftover temp files, list, and encrypt older plain files when a key is set. */
  async init(): Promise<void> {
    const dir = this.store.dir;
    try {
      await this.store.probe();
    } catch (err) {
      this.log.error(
        { dir, uid: process.getuid?.(), err: (err as Error).message },
        `SNAPSHOTS_DIR ${dir} is not writable: snapshots cannot be saved or loaded. Make the folder writable by the server's user (Docker on Linux: sudo chown -R 1000:1000 on the host folder)`,
      );
      this.hub.publish('snapshots', this.payload());
      return;
    }
    const removed = await this.store.sweepTmp().catch(() => 0);
    if (removed) this.log.info({ removed }, 'removed temp files left over from an interrupted snapshot write');
    await this.refresh().catch((err) => this.log.warn({ err: (err as Error).message }, 'could not list the saved snapshots'));
    if (this.store.encrypting) {
      void this.store
        .encryptPlaintext()
        .then(async (names) => {
          if (!names.length) return;
          this.log.info({ count: names.length, snapshots: names }, `encrypted ${names.length} saved snapshot(s) with SNAPSHOTS_KEY`);
          await this.refresh();
        })
        .catch((err) => this.log.warn({ err: (err as Error).message }, 'could not encrypt the saved snapshots'));
    }
  }

  /** Publish when this browser loads, refreshes or loses a snapshot. */
  track(browser: Browser): void {
    if (this.tracked.has(browser)) return;
    this.tracked.add(browser);
    browser.on('snapshots', () => this.schedulePublish());
  }

  private schedulePublish(): void {
    if (this.publishQueued) return;
    this.publishQueued = true;
    setImmediate(() => {
      this.publishQueued = false;
      this.hub.publish('snapshots', this.payload());
    });
  }

  /** Re-read the metadata list from disk (after a store change) and publish it. */
  async refresh(): Promise<SnapshotListing> {
    this.listing = await this.store.list();
    this.hub.publish('snapshots', this.payload());
    return this.listing;
  }

  /** Open browsers (main, sub-agents), for the loaded/active markers. */
  private browsers(): Browser[] {
    return this.registry
      .list()
      .filter((b) => b.status === 'open')
      .map((b) => this.registry.browser(b.id))
      .filter((b): b is Browser => b !== null);
  }

  /** The dashboard's view of every snapshot, from the in-memory list (synchronous). */
  payload(): SnapshotsPayload {
    const browsers = this.browsers();
    const markers = (name: string) => ({
      loaded_in: browsers.filter((b) => b.loadedSnapshots.has(name)).map((b) => b.id),
      active_in: browsers.filter((b) => b.activeSnapshot === name).map((b) => b.id),
    });
    const now = nowSeconds();
    const snapshots: SnapshotView[] = this.listing.snapshots.map((m) => {
      const next = m.expiries.find((e) => e > now);
      const actor = (a: SnapshotActor) => ({ ...(a.client ? { client: a.client } : {}), ...(a.runId ? { run_id: a.runId } : {}) });
      return {
        name: m.name,
        description: m.description,
        version: m.version,
        created_at: m.createdAt,
        updated_at: m.updatedAt,
        created_by: actor(m.createdBy),
        updated_by: actor(m.updatedBy),
        domains: m.domains,
        cookie_count: m.cookieCount,
        session_cookie_count: m.sessionCookieCount,
        cookie_domains: m.cookieDomains,
        expired_count: m.expiries.filter((e) => e <= now).length,
        next_expiry: next ? new Date(next * 1000).toISOString() : null,
        origins: m.origins.map((o) => ({ origin: o.origin, local_storage: o.localStorage, session_storage: o.sessionStorage })),
        loads: m.loads,
        last_loaded_at: m.lastLoadedAt,
        encrypted: m.encrypted,
        bytes: m.bytes,
        ...(m.stale ? { stale: true } : {}),
        ...(m.incomplete ? { incomplete: true } : {}),
        ...markers(m.name),
      };
    });
    for (const name of this.listing.incomplete) snapshots.push({ name, incomplete: true, ...markers(name) });
    return {
      snapshots,
      dir: this.store.dir,
      encrypted: this.store.encrypting,
      unencrypted_count: this.listing.snapshots.filter((m) => !m.encrypted && !m.incomplete).length,
    };
  }

  /** Fresh list from disk, as the payload. */
  async list(): Promise<SnapshotsPayload> {
    await this.refresh();
    return this.payload();
  }

  /** Metadata of one snapshot, or a SnapshotError that lists the saved names. */
  async get(name: string): Promise<SnapshotMeta> {
    try {
      return await this.store.get(name);
    } catch (err) {
      if (!(err instanceof SnapshotNotFoundError)) throw err;
      const names = (await this.store.list()).snapshots.map((m) => m.name);
      throw new SnapshotNotFoundError(`No snapshot named ${JSON.stringify(name)}. Saved snapshots: ${names.join(', ') || 'none'} (see snapshot_list).`);
    }
  }

  /** The site of the active tab (host without "www."), or null when it is not on a web page. */
  async activeSite(browser: Browser): Promise<string | null> {
    const current = await activeOrigin(browser.activeTab);
    return current ? siteOfHost(new URL(current.origin).hostname) : null;
  }

  /** This browser's cookies for the filter and the active tab's storage (when its site is in the filter). */
  private async capture(browser: Browser, filter: string[]): Promise<{ cookies: CookieOut[]; origin: OriginState | null }> {
    const now = nowSeconds();
    const jar = (await allCookies(browser, { quiet: true })).filter((c) => inScope(c.domain, filter) && !(c.expires > 0 && c.expires <= now));
    const cookies = sortCookies(jar).map(toCookieOut);
    const st = await readActiveStorage(browser.activeTab, { quiet: true });
    return { cookies, origin: st && originInScope(st.origin, filter) ? st : null };
  }

  /** Refuse captures that would save the wrong thing (see snapshot_save). */
  private guardCapture(browser: Browser, name: string, filter: string[], cookies: CookieOut[], what: string): void {
    if (filter.includes('*')) {
      const other = [...browser.loadedSnapshots.keys()].find((n) => n !== name);
      if (other) {
        throw new SnapshotError(
          `Snapshot ${JSON.stringify(name)} saves every cookie of this browser (domains ["*"]), and snapshot ${JSON.stringify(other)} is also loaded here, so its sign-in would be saved into it. ` +
            'Create it with domains, or load it again first.',
        );
      }
    }
    if (!cookies.length) throw new SnapshotEmptyError(`This browser has no sign-in cookies for ${domainsText(filter)}; ${what}.`);
  }

  /** Whether `name` was deleted after the deletion count `since` was read. */
  private deletedSince(name: string, since: number): boolean {
    return (this.deletedAt.get(name) ?? 0) > since;
  }

  /** After a capture: this browser has that version loaded and active, and its storage seed has the captured values. */
  private async afterCapture(browser: Browser, meta: SnapshotMeta, origin: OriginState | null, generation: number, since: number): Promise<void> {
    this.track(browser);
    if (browser.connectionGeneration !== generation) return; // the connection was lost meanwhile: nothing of it is loaded
    if (this.deletedSince(meta.name, since)) return; // deleted right after it was saved: never marked loaded
    if (origin) {
      if (origin.localStorage.length || origin.sessionStorage.length) {
        browser.storageSeed.set(origin.origin, { snapshot: meta.name, localStorage: origin.localStorage, sessionStorage: origin.sessionStorage });
      } else if (browser.storageSeed.get(origin.origin)?.snapshot === meta.name) {
        browser.storageSeed.delete(origin.origin);
      }
      await this.registerSeed(browser, await browser.connection(), generation);
    }
    browser.markSnapshot(meta.name, meta.version, generation);
  }

  /** Register the storage seed of this browser (add the new script, then remove the old one of the same connection). */
  private async registerSeed(browser: Browser, conn: CdpConnection, generation: number): Promise<void> {
    const old = browser.seedScript;
    let next: { id: string; generation: number } | null = null;
    if (browser.storageSeed.size) {
      const res = await quietSend<{ identifier: string }>(conn, 'Page.addScriptToEvaluateOnNewDocument', { source: seedSource(browser.storageSeed) });
      next = { id: String(res.identifier), generation };
    }
    // identifiers restart on every connection: an old one from another connection would remove the new script
    if (old && old.generation === generation) await quietSend(conn, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: old.id }).catch(() => undefined);
    browser.seedScript = next;
  }

  /** Create a snapshot from this browser's sign-in (create-only). */
  async create(browser: Browser, input: { name: string; description: string; domains: string[]; by: SnapshotActor }): Promise<SaveOutcome> {
    const name = normalizeSnapshotName(input.name);
    if (await this.store.exists(name)) {
      const valid = await this.store.get(name).then(() => true, () => false);
      throw new SnapshotError(
        valid
          ? `A snapshot named ${JSON.stringify(name)} already exists; choose another name.`
          : `An incomplete snapshot named ${JSON.stringify(name)} exists (saved state without valid metadata); save under another name, or ask your user whether to delete it with snapshot_delete.`,
      );
    }
    const generation = browser.connectionGeneration;
    const since = this.deletions;
    const captured = await this.capture(browser, input.domains);
    this.guardCapture(browser, name, input.domains, captured.cookies, 'no snapshot was saved');
    const meta = await this.store.create({
      name,
      description: input.description,
      domains: input.domains,
      cookies: captured.cookies,
      origins: captured.origin ? [captured.origin] : [],
      by: input.by,
    });
    this.log.info({ snapshot: name, version: meta.version, cookies: meta.cookieCount, origins: meta.origins.length, by: input.by }, `snapshot ${name} created`);
    await this.afterCapture(browser, meta, captured.origin, generation, since);
    await this.refresh().catch(() => undefined);
    return { meta, action: 'created', cookieDomains: meta.cookieDomains, storageOrigin: captured.origin?.origin ?? null };
  }

  /**
   * Save this browser's sign-in into an existing snapshot. refresh: keep its domain filter and merge
   * the stored site storage (only the open page's can be read); refused when the stored version is not
   * `expectVersion`. replace: overwrite it (a new domain filter when given). Never creates.
   */
  async update(
    browser: Browser,
    name: string,
    input: { mode: 'refresh' | 'replace'; by: SnapshotActor; expectVersion?: number; domains?: string[]; description?: string },
  ): Promise<SaveOutcome> {
    const stored = await this.store.get(name);
    const filter = input.mode === 'replace' && input.domains?.length ? input.domains : stored.domains;
    const generation = browser.connectionGeneration;
    const since = this.deletions;
    const captured = await this.capture(browser, filter);
    this.guardCapture(browser, name, filter, captured.cookies, 'snapshot not changed');
    const meta = await this.store.update(name, input.by, async (current) => {
      if (input.expectVersion !== undefined && current.version !== input.expectVersion) {
        throw new SnapshotConflictError(
          `${actorText(current.updatedBy)} saved v${current.version} of snapshot ${JSON.stringify(name)} after this browser loaded v${input.expectVersion}`,
          current,
        );
      }
      let origins: OriginState[] = captured.origin ? [captured.origin] : [];
      if (input.mode === 'refresh') {
        // storage of other sites cannot be read now (it exists only while their page is open): keep it
        const old = await this.store.readState(name);
        const kept = old.origins.filter((o) => o.origin !== captured.origin?.origin && originInScope(o.origin, filter));
        origins = [...kept, ...origins];
      }
      return { cookies: captured.cookies, origins, domains: input.mode === 'replace' && input.domains?.length ? input.domains : undefined, description: input.description };
    });
    const action: SaveAction = input.mode === 'replace' ? 'replaced' : 'refreshed';
    this.log.info({ snapshot: name, version: meta.version, cookies: meta.cookieCount, origins: meta.origins.length, by: input.by }, `snapshot ${name} ${action}`);
    await this.afterCapture(browser, meta, captured.origin, generation, since);
    await this.refresh().catch(() => undefined);
    return { meta, action, cookieDomains: meta.cookieDomains, storageOrigin: captured.origin?.origin ?? null };
  }

  /** Change only the description. */
  async describe(name: string, description: string): Promise<SnapshotMeta> {
    const meta = await this.store.describe(name, description);
    this.log.info({ snapshot: name, version: meta.version }, `snapshot ${name} description changed`);
    await this.refresh().catch(() => undefined);
    return meta;
  }

  /**
   * Load a snapshot into this browser: its cookies for the snapshot's sites replace the browser's own
   * (other sites' cookies stay), and its site storage is written on every page load of its origins.
   * With `conn` (a reconnect), everything goes over that new connection.
   */
  async apply(browser: Browser, name: string, opts: { conn?: CdpConnection; generation?: number; countLoad?: boolean } = {}): Promise<ApplyOutcome> {
    const since = this.deletions;
    const meta = await this.store.get(name);
    const state = await this.store.readState(name);
    const conn = opts.conn ?? (await browser.connection());
    const generation = opts.generation ?? browser.connectionGeneration;
    const filter = meta.domains;
    this.track(browser);

    // the browser's own cookies for these sites go first, so two accounts never mix
    if (filter.includes('*')) {
      try {
        await quietSend(conn, 'Network.clearBrowserCookies');
      } catch {
        await quietSend(conn, 'Storage.clearCookies');
      }
    } else {
      const jar = (await quietSend<{ cookies?: CdpCookie[] }>(conn, 'Network.getAllCookies')).cookies ?? [];
      for (const c of jar.filter((j) => inScope(j.domain, filter))) {
        await quietSend(conn, 'Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
      }
    }
    const stateOrigins = new Set(state.origins.map((o) => normalizeOrigin(String(o?.origin ?? ''))).filter(Boolean));
    for (const [origin, entry] of browser.storageSeed) {
      if (entry.snapshot === name || stateOrigins.has(origin) || originInScope(origin, filter)) browser.storageSeed.delete(origin);
    }

    // cookies: expired and refused ones are reported by domain and count, never by name
    const now = nowSeconds();
    const valid: CookieParam[] = [];
    const expired = new Map<string, number>();
    const refused = new Map<string, number>();
    for (const c of state.cookies) {
      const domain = canonicalDomain(String((c as { domain?: unknown })?.domain ?? '')) || '(no domain)';
      if (typeof c?.expires === 'number' && c.expires > 0 && c.expires <= now) {
        bump(expired, domain);
        continue;
      }
      const param = cookieParam(c, this.config);
      if (typeof param === 'string') bump(refused, domain);
      else valid.push(param);
    }
    let restored = 0;
    if (valid.length) {
      await quietSend(conn, 'Network.setCookies', { cookies: valid });
      const jar = (await quietSend<{ cookies?: CdpCookie[] }>(conn, 'Network.getAllCookies')).cookies ?? [];
      for (const c of valid) {
        if (jar.some((j) => j.name === c.name && canonicalDomain(j.domain) === c.domain && j.path === c.path && j.value === c.value)) restored++;
        else bump(refused, c.domain);
      }
    }

    // site storage: written on every page load of its origins
    const storageOrigins: string[] = [];
    for (const o of state.origins) {
      const origin = normalizeOrigin(String(o?.origin ?? ''));
      if (!origin) continue;
      const local = storageItems(o.localStorage, 'localStorage').items;
      const session = storageItems(o.sessionStorage, 'sessionStorage').items;
      if (!local.length && !session.length) continue;
      browser.storageSeed.set(origin, { snapshot: name, localStorage: local, sessionStorage: session });
      storageOrigins.push(origin);
    }
    await this.registerSeed(browser, conn, generation);

    // the page open now gets it at once (the seed only runs on the next page load)
    let appliedNow = false;
    if (!opts.conn) {
      const current = await activeOrigin(browser.activeTab);
      const seed = current ? browser.storageSeed.get(current.origin) : undefined;
      if (current && seed?.snapshot === name) {
        const entries = [...seed.localStorage.map((i) => ({ ...i, session: false })), ...seed.sessionStorage.map((i) => ({ ...i, session: true }))];
        appliedNow = (await applyStorage(current.tab, entries, { quiet: true }).catch(() => ({ applied: 0 }))).applied > 0;
      }
    }

    if (this.deletedSince(name, since)) {
      // deleted while it was being loaded: take its storage back out and report it gone
      if (browser.forgetSnapshot(name) && browser.connectionGeneration === generation) await this.registerSeed(browser, conn, generation).catch(() => undefined);
      throw new SnapshotNotFoundError(`Snapshot ${JSON.stringify(name)} was deleted while it was being loaded`);
    }
    // only when the connection it all went into is still the browser's
    if (browser.connectionGeneration === generation) browser.markSnapshot(name, meta.version, generation);
    this.log.info(
      { snapshot: name, version: meta.version, browserId: browser.id, restored, cookies: state.cookies.length, expired: sum(expired), refused: sum(refused), origins: storageOrigins.length },
      `snapshot ${name} loaded into ${browser.id === MAIN_BROWSER ? 'the main browser' : browser.id}`,
    );
    if (opts.countLoad !== false) {
      void this.store
        .recordLoad(name)
        .then(() => this.refresh())
        .catch((err) => this.log.warn({ snapshot: name, err: (err as Error).message }, 'could not count a snapshot load'));
    }
    return { meta, restored, total: state.cookies.length, expired, refused, storageOrigins, appliedNow };
  }

  /**
   * Delete for good (only on the user's request): the files, the markers in every browser, and its
   * storage from every browser's seed. Cookies it already put into a browser stay there.
   */
  async delete(name: string, client: string | null): Promise<{ loadedIn: string[] }> {
    await this.store.delete(name);
    this.deletedAt.set(name, ++this.deletions);
    const loadedIn: string[] = [];
    for (const browser of this.browsers()) {
      if (browser.loadedSnapshots.has(name)) loadedIn.push(browser.id);
      // a disconnected browser has no seed left to change (it is cleared with the connection)
      if (browser.forgetSnapshot(name) && browser.connected) {
        // under the browser's queue, so it never interleaves with a load or save there
        void browser.mutex
          .run(async () => this.registerSeed(browser, await browser.connection(), browser.connectionGeneration))
          .catch((err) => this.log.warn({ snapshot: name, browserId: browser.id, err: (err as Error).message }, 'could not remove a deleted snapshot from a browser'));
      }
    }
    this.log.info({ snapshot: name, client, loadedIn }, `snapshot ${name} deleted`);
    this.emit('deleted', name);
    await this.refresh().catch(() => undefined);
    return { loadedIn };
  }

  /**
   * An agent browser whose run started with a snapshot gets it back after the engine restarted (called
   * by the browser before the new connection is used). Resolves to the notice for the agent.
   */
  installReconnect(browser: Browser, name: string): void {
    browser.reconnectHook = async (conn, generation) => {
      const quoted = JSON.stringify(name);
      try {
        await this.apply(browser, name, { conn, generation, countLoad: false });
        return `The browser was reset; your saved sign-in ${quoted} was re-applied; open the page again.`;
      } catch (err) {
        this.log.warn({ snapshot: name, browserId: browser.id, err: (err as Error).message }, 'could not re-apply a snapshot after the browser was reset');
        return `The browser was reset; your saved sign-in ${quoted} was lost; sign in again or finish with success=false.`;
      }
    };
  }
}

function sum(map: Map<string, number>): number {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}

/** "2 expired cookies for amazon.com, 1 for amazon.de". */
export function countsText(map: Map<string, number>, what: string): string {
  const parts = [...map.entries()].sort((a, b) => b[1] - a[1]).map(([d, n], i) => (i === 0 ? `${n} ${what} for ${d}` : `${n} for ${d}`));
  return parts.length > 4 ? `${parts.slice(0, 4).join(', ')} and more` : parts.join(', ');
}
