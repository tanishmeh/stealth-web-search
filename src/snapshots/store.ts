import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import path from 'node:path';
import { canonicalDomain, type CookieOut, type OriginState } from '../browser/storage-state.ts';
import type { Logger } from '../logger.ts';

/**
 * Saved sign-ins ("snapshots") on disk (SNAPSHOTS_DIR, mode 0700): `<name>.json` holds metadata only
 * (description, counts, cookie domains; never cookie names or values) and `<name>.state` the cookies
 * and site storage, written 0600 and, with SNAPSHOTS_KEY, encrypted (AES-256-GCM, key from scrypt).
 * The state file is written first and is authoritative; listing reads only metadata files.
 */

export const MAX_SNAPSHOTS = 500;
/** Largest state (cookies and site storage, as JSON) one snapshot may hold. */
export const MAX_STATE_BYTES = 5 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** scrypt cost of new files (32 MiB, about 0.1 s); the envelope records it. */
const KDF = { n: 32_768, r: 8, p: 1 };
/** A *.tmp file older than this is left over from a crash (a write takes milliseconds). */
const TMP_MAX_AGE_MS = 60_000;

export class SnapshotError extends Error {}
export class SnapshotNotFoundError extends SnapshotError {}
export class SnapshotDecryptError extends SnapshotError {}

/** Who saved a snapshot: an MCP client, or a sub-agent run. */
export interface SnapshotActor {
  client?: string;
  runId?: string;
}

export interface SnapshotOrigin {
  origin: string;
  localStorage: number;
  sessionStorage: number;
}

export interface SnapshotMeta {
  name: string;
  description: string;
  /** Increases with every saved state (a description change keeps it). */
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: SnapshotActor;
  updatedBy: SnapshotActor;
  /** Domain filter the state was captured with (["*"]: every cookie). */
  domains: string[];
  cookieCount: number;
  sessionCookieCount: number;
  cookieDomains: string[];
  /** Sorted expiry times (unix seconds) of the non-session cookies: no names, no domains. */
  expiries: number[];
  origins: SnapshotOrigin[];
  loads: number;
  lastLoadedAt: string | null;
  encrypted: boolean;
  /** Size of the state file. */
  bytes: number;
}

/** The secret payload: cookies of the jar and site storage per origin. */
export interface SnapshotState {
  version: number;
  cookies: CookieOut[];
  origins: OriginState[];
}

export interface SnapshotListing {
  /** Valid metadata, most recently updated first. `stale`: the state file is newer (a write was cut off); `incomplete`: no state file. */
  snapshots: Array<SnapshotMeta & { stale?: boolean; incomplete?: boolean }>;
  /** State files without valid metadata: listed so they can be deleted (never removed automatically). */
  incomplete: string[];
}

/** Trim, lowercase and turn whitespace into "-", then check: 1-64 of [a-z0-9_-], starting with a letter or digit. */
export function normalizeSnapshotName(input: string): string {
  const name = input.trim().toLowerCase().replace(/\s+/g, '-');
  if (!NAME.test(name)) {
    throw new SnapshotError(`Invalid snapshot name ${JSON.stringify(input.slice(0, 80))}: use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  }
  return name;
}

function validateName(name: string): string {
  if (!NAME.test(name)) throw new SnapshotError(`Invalid snapshot name ${JSON.stringify(name.slice(0, 80))}`);
  return name;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const actor = (v: unknown): SnapshotActor => {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: SnapshotActor = {};
  if (typeof a.client === 'string') out.client = a.client;
  if (typeof a.runId === 'string') out.runId = a.runId;
  return out;
};

/** Metadata with the shape the server relies on (hand-edited or copied files may not have it), or null. */
function parseMeta(raw: unknown, name: string): SnapshotMeta | null {
  const m = raw as Record<string, any>;
  if (!m || typeof m !== 'object' || m.name !== name || typeof m.version !== 'number' || typeof m.description !== 'string' || !isStrings(m.domains)) return null;
  return {
    name,
    description: m.description,
    version: m.version,
    createdAt: String(m.createdAt ?? ''),
    updatedAt: String(m.updatedAt ?? m.createdAt ?? ''),
    createdBy: actor(m.createdBy),
    updatedBy: actor(m.updatedBy),
    domains: m.domains,
    cookieCount: num(m.cookieCount),
    sessionCookieCount: num(m.sessionCookieCount),
    cookieDomains: isStrings(m.cookieDomains) ? m.cookieDomains : [],
    expiries: Array.isArray(m.expiries) ? m.expiries.filter((x: unknown) => typeof x === 'number') : [],
    origins: Array.isArray(m.origins)
      ? m.origins
          .filter((o: any) => o && typeof o.origin === 'string')
          .map((o: any) => ({ origin: o.origin, localStorage: num(o.localStorage), sessionStorage: num(o.sessionStorage) }))
      : [],
    loads: num(m.loads),
    lastLoadedAt: typeof m.lastLoadedAt === 'string' ? m.lastLoadedAt : null,
    encrypted: m.encrypted === true,
    bytes: num(m.bytes),
  };
}

function parseState(raw: unknown): SnapshotState | null {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== 'object' || !Array.isArray(s.cookies) || !Array.isArray(s.origins)) return null;
  return { version: num(s.version), cookies: s.cookies as CookieOut[], origins: s.origins as OriginState[] };
}

/** Counts and domains of a state, for its metadata (never names or values). */
function describeState(state: SnapshotState) {
  const expiries = state.cookies.filter((c) => typeof c.expires === 'number' && c.expires > 0).map((c) => c.expires).sort((a, b) => a - b);
  return {
    cookieCount: state.cookies.length,
    sessionCookieCount: state.cookies.length - expiries.length,
    cookieDomains: [...new Set(state.cookies.map((c) => canonicalDomain(String(c.domain ?? ''))).filter(Boolean))].sort(),
    expiries,
    origins: state.origins.map((o) => ({ origin: o.origin, localStorage: o.localStorage?.length ?? 0, sessionStorage: o.sessionStorage?.length ?? 0 })),
  };
}

interface Envelope {
  v: 1;
  alg: 'aes-256-gcm';
  kdf: { n: number; r: number; p: number };
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** An encrypted state file, recognised by its envelope (never by the metadata). */
function isEnvelope(value: unknown): value is Envelope {
  const e = value as Record<string, unknown>;
  return Boolean(e) && typeof e === 'object' && (typeof e.alg === 'string' || typeof e.data === 'string') && !Array.isArray(e.cookies);
}

function deriveKey(secret: string, salt: Buffer, kdf: { n: number; r: number; p: number }): Promise<Buffer> {
  // async: scrypt must not block the event loop that serves every browser
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.n * kdf.r + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export class SnapshotStore {
  readonly dir: string;
  private readonly key: string | undefined;
  private readonly log: Logger;
  private ready: Promise<void> | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dir: string, key: string | undefined, log: Logger) {
    this.dir = dir;
    this.key = key || undefined;
    this.log = log;
  }

  /** Whether new and rewritten state files are encrypted (SNAPSHOTS_KEY is set). */
  get encrypting(): boolean {
    return Boolean(this.key);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= this.prepareDir().catch((err) => {
      this.ready = null; // try again on the next call (e.g. after the volume was fixed)
      throw err;
    });
    return this.ready;
  }

  /** Create the directory owner-only (0700); an existing one readable by others is restricted, or a warning logged. */
  private async prepareDir(): Promise<void> {
    const created = await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (created !== undefined) {
      await chmod(this.dir, 0o700); // the umask may have cut the mode; make sure
      return;
    }
    const st = await stat(this.dir);
    if (!st.isDirectory()) throw new SnapshotError(`SNAPSHOTS_DIR ${this.dir} is not a directory`);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      try {
        await chmod(this.dir, 0o700);
        this.log.info({ dir: this.dir, mode: (st.mode & 0o777).toString(8) }, 'restricted SNAPSHOTS_DIR to its owner (mode 0700)');
      } catch (err) {
        this.log.warn(
          { dir: this.dir, mode: (st.mode & 0o777).toString(8), err: (err as Error).message },
          'SNAPSHOTS_DIR can be read by other users and its mode could not be changed to 0700: saved sign-ins may be readable by them',
        );
      }
    }
  }

  /** Write access, checked at startup (the error names the directory and the server's uid). */
  async probe(): Promise<void> {
    await this.ensureDir();
    const probe = path.join(this.dir, `.write-test-${process.pid}`);
    await writeFile(probe, '', { mode: 0o600 });
    await rm(probe, { force: true });
  }

  private file(name: string, ext: 'json' | 'state'): string {
    return path.join(this.dir, `${validateName(name)}.${ext}`);
  }

  /** Serialize read-modify-write operations per snapshot (one server process uses the directory). */
  private locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(name, tail);
    void tail.then(() => {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    });
    return next;
  }

  /** Write a file in full: a random 0600 temp file (never an existing one), then a rename over the target. */
  private async atomicWrite(name: string, target: string, content: string): Promise<void> {
    const tmp = path.join(this.dir, `${name}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const existing = await lstat(target).catch(() => null);
      if (existing && !existing.isFile()) throw new SnapshotError(`${path.basename(target)} is not a regular file; refusing to write it`);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Read a regular file (never through a symbolic link). */
  private async readRegular(file: string, maxBytes: number): Promise<string> {
    const nofollow = constants.O_NOFOLLOW ?? 0;
    if (!nofollow) {
      const st = await lstat(file);
      if (!st.isFile()) throw new SnapshotError(`${path.basename(file)} is not a regular file`);
    }
    let fh;
    try {
      fh = await open(file, constants.O_RDONLY | nofollow);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new SnapshotError(`${path.basename(file)} is a symbolic link; snapshot files must be regular files`);
      throw err;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new SnapshotError(`${path.basename(file)} is not a regular file`);
      if (st.size > maxBytes) throw new SnapshotError(`${path.basename(file)} is too large (${st.size} bytes)`);
      return await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
  }

  private async readMetaFile(name: string): Promise<SnapshotMeta> {
    let raw: string;
    try {
      raw = await this.readRegular(this.file(name, 'json'), 4 * 1024 * 1024);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SnapshotNotFoundError(`No snapshot named ${JSON.stringify(name)}`);
      throw err;
    }
    let meta: SnapshotMeta | null = null;
    try {
      meta = parseMeta(JSON.parse(raw), name);
    } catch {
      meta = null;
    }
    if (!meta) throw new SnapshotError(`The metadata of snapshot ${JSON.stringify(name)} (${name}.json) is invalid; save under another name, or ask your user whether to delete it (snapshot_delete)`);
    return meta;
  }

  private async isStale(name: string): Promise<boolean> {
    const [s, j] = await Promise.all([lstat(this.file(name, 'state')).catch(() => null), lstat(this.file(name, 'json')).catch(() => null)]);
    return Boolean(s && j && s.mtimeMs > j.mtimeMs + 1);
  }

  /** Metadata, and inside a lock recomputed from the state file when a write was cut off after it (the state is authoritative). */
  private async freshMeta(name: string): Promise<SnapshotMeta> {
    const meta = await this.readMetaFile(name);
    if (!(await this.isStale(name))) return meta;
    try {
      const { state, encrypted, bytes } = await this.readStateFile(name);
      return { ...meta, ...describeState(state), version: Math.max(meta.version, state.version), encrypted, bytes };
    } catch {
      return meta; // cannot read it (e.g. SNAPSHOTS_KEY changed): keep what the metadata says
    }
  }

  async list(): Promise<SnapshotListing> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const stem = (f: string, ext: string) => (f.endsWith(ext) && NAME.test(f.slice(0, -ext.length)) ? f.slice(0, -ext.length) : null);
    const states = new Set(files.map((f) => stem(f, '.state')).filter((n): n is string => n !== null));
    const snapshots: SnapshotListing['snapshots'] = [];
    const valid = new Set<string>();
    for (const name of files.map((f) => stem(f, '.json')).filter((n): n is string => n !== null)) {
      try {
        const meta: SnapshotListing['snapshots'][number] = await this.readMetaFile(name);
        if (!states.has(name)) meta.incomplete = true;
        else if (await this.isStale(name)) meta.stale = true;
        snapshots.push(meta);
        valid.add(name);
      } catch {
        // invalid metadata: reported below when its state file exists
      }
    }
    snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { snapshots, incomplete: [...states].filter((n) => !valid.has(n)).sort() };
  }

  /** Metadata of one snapshot; SnapshotNotFoundError when there is none. */
  async get(name: string): Promise<SnapshotMeta> {
    await this.ensureDir();
    return this.readMetaFile(name);
  }

  /** Whether either file of the snapshot exists (even with broken metadata). */
  async exists(name: string): Promise<boolean> {
    for (const ext of ['json', 'state'] as const) {
      if (await lstat(this.file(name, ext)).then(() => true, () => false)) return true;
    }
    return false;
  }

  private async readStateFile(name: string): Promise<{ state: SnapshotState; encrypted: boolean; bytes: number }> {
    let raw: string;
    try {
      raw = await this.readRegular(this.file(name, 'state'), 2 * MAX_STATE_BYTES);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SnapshotNotFoundError(`Snapshot ${JSON.stringify(name)} has no saved state`);
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SnapshotError(`The saved state of snapshot ${JSON.stringify(name)} is not valid JSON`);
    }
    let plain: unknown = parsed;
    let encrypted = false;
    if (isEnvelope(parsed)) {
      encrypted = true;
      try {
        plain = JSON.parse(await this.decrypt(name, parsed));
      } catch (err) {
        if (err instanceof SnapshotError) throw err;
        throw new SnapshotError(`The saved state of snapshot ${JSON.stringify(name)} is invalid`);
      }
    }
    const state = parseState(plain);
    if (!state) throw new SnapshotError(`The saved state of snapshot ${JSON.stringify(name)} is invalid`);
    return { state, encrypted, bytes: Buffer.byteLength(raw) };
  }

  /** The cookies and site storage of a snapshot (decrypted). */
  async readState(name: string): Promise<SnapshotState> {
    await this.ensureDir();
    return (await this.readStateFile(name)).state;
  }

  private async encrypt(name: string, plaintext: string): Promise<string> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(this.key!, salt, KDF);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // bound to the name: a state file copied over another snapshot's does not decrypt
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      v: 1,
      alg: 'aes-256-gcm',
      kdf: { ...KDF },
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    return `${JSON.stringify(envelope)}\n`;
  }

  private async decrypt(name: string, envelope: Envelope): Promise<string> {
    const refused = new SnapshotDecryptError(`cannot decrypt snapshot ${JSON.stringify(name)}: SNAPSHOTS_KEY is missing or differs from the one used to save it`);
    if (!this.key) throw refused;
    const { n, r, p } = envelope.kdf ?? ({} as Envelope['kdf']);
    // bounded, so a hand-edited file cannot make scrypt use gigabytes of memory
    const powerOfTwo = Number.isInteger(n) && n >= 1_024 && (n & (n - 1)) === 0;
    const bounded = powerOfTwo && Number.isInteger(r) && r >= 1 && Number.isInteger(p) && p >= 1 && p <= 4 && 128 * n * r <= 256 * 1024 * 1024;
    if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm' || !bounded || typeof envelope.data !== 'string') {
      throw new SnapshotDecryptError(`cannot decrypt snapshot ${JSON.stringify(name)}: unsupported encryption format`);
    }
    try {
      const key = await deriveKey(this.key, Buffer.from(envelope.salt, 'base64'), { n, r, p });
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(name, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw refused;
    }
  }

  /** Write the state file (encrypted when a key is set), then the metadata. */
  private async writeSnapshot(meta: Omit<SnapshotMeta, 'encrypted' | 'bytes' | 'cookieCount' | 'sessionCookieCount' | 'cookieDomains' | 'expiries' | 'origins'>, state: SnapshotState): Promise<SnapshotMeta> {
    const plaintext = JSON.stringify({ version: meta.version, cookies: state.cookies, origins: state.origins });
    const size = Buffer.byteLength(plaintext);
    if (size > MAX_STATE_BYTES) {
      throw new SnapshotError(`The sign-in to save is too large (${(size / 1024 / 1024).toFixed(1)} MB; at most ${MAX_STATE_BYTES / 1024 / 1024} MB). Save fewer sites (domains).`);
    }
    const body = this.key ? await this.encrypt(meta.name, plaintext) : `${plaintext}\n`;
    await this.atomicWrite(meta.name, this.file(meta.name, 'state'), body);
    const full: SnapshotMeta = { ...meta, ...describeState({ ...state, version: meta.version }), encrypted: Boolean(this.key), bytes: Buffer.byteLength(body) };
    await this.writeMeta(full);
    return full;
  }

  private writeMeta(meta: SnapshotMeta): Promise<void> {
    return this.atomicWrite(meta.name, this.file(meta.name, 'json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  private async countNames(): Promise<number> {
    const names = new Set<string>();
    for (const f of await readdir(this.dir)) {
      const m = /^(.+)\.(json|state)$/.exec(f);
      if (m && NAME.test(m[1]!)) names.add(m[1]!);
    }
    return names.size;
  }

  /** Create a snapshot. Create-only: fails when either file of that name exists (even a broken one). */
  create(input: { name: string; description: string; domains: string[]; cookies: CookieOut[]; origins: OriginState[]; by: SnapshotActor }): Promise<SnapshotMeta> {
    const name = validateName(input.name);
    return this.locked(name, async () => {
      await this.ensureDir();
      if (await this.exists(name)) throw new SnapshotError(`A snapshot named ${JSON.stringify(name)} already exists`);
      if ((await this.countNames()) >= MAX_SNAPSHOTS) {
        throw new SnapshotError(`Snapshot limit (${MAX_SNAPSHOTS}) reached. Ask your user which snapshot to delete; never delete one on your own.`);
      }
      const now = new Date().toISOString();
      return this.writeSnapshot(
        { name, description: input.description, version: 1, createdAt: now, updatedAt: now, createdBy: input.by, updatedBy: input.by, domains: input.domains, loads: 0, lastLoadedAt: null },
        { version: 1, cookies: input.cookies, origins: input.origins },
      );
    });
  }

  /**
   * Save a new state for an existing snapshot. `build` runs inside the snapshot's lock with its current
   * metadata (it may throw to refuse, e.g. on a version conflict). Never creates: a deleted snapshot
   * gives SnapshotNotFoundError.
   */
  update(
    name: string,
    by: SnapshotActor,
    build: (current: SnapshotMeta) => Promise<{ cookies: CookieOut[]; origins: OriginState[]; domains?: string[]; description?: string }>,
  ): Promise<SnapshotMeta> {
    validateName(name);
    return this.locked(name, async () => {
      await this.ensureDir();
      const current = await this.freshMeta(name);
      const next = await build(current);
      const version = current.version + 1;
      return this.writeSnapshot(
        {
          name,
          description: next.description ?? current.description,
          version,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
          createdBy: current.createdBy,
          updatedBy: by,
          domains: next.domains ?? current.domains,
          loads: current.loads,
          lastLoadedAt: current.lastLoadedAt,
        },
        { version, cookies: next.cookies, origins: next.origins },
      );
    });
  }

  /** Change only the description (the version stays: what browsers loaded is unchanged). */
  describe(name: string, description: string): Promise<SnapshotMeta> {
    validateName(name);
    return this.locked(name, async () => {
      await this.ensureDir();
      const meta = { ...(await this.freshMeta(name)), description };
      await this.writeMeta(meta);
      return meta;
    });
  }

  /** Count a load (best effort for callers); never creates. */
  recordLoad(name: string): Promise<void> {
    validateName(name);
    return this.locked(name, async () => {
      await this.ensureDir();
      const meta = await this.freshMeta(name);
      await this.writeMeta({ ...meta, loads: meta.loads + 1, lastLoadedAt: new Date().toISOString() });
    });
  }

  /** Delete for good: the state (credentials) first, then the metadata. Works for incomplete entries too. */
  delete(name: string): Promise<void> {
    validateName(name);
    return this.locked(name, async () => {
      await this.ensureDir();
      let found = false;
      for (const ext of ['state', 'json'] as const) {
        try {
          await rm(this.file(name, ext));
          found = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      if (!found) throw new SnapshotNotFoundError(`No snapshot named ${JSON.stringify(name)}`);
    });
  }

  /** Remove temp files a crash left behind (older than a minute: a write in progress is never touched). */
  async sweepTmp(): Promise<number> {
    await this.ensureDir();
    let removed = 0;
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.tmp')) continue;
      const file = path.join(this.dir, f);
      const st = await lstat(file).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < TMP_MAX_AGE_MS) continue;
      await rm(file, { force: true }).then(() => removed++, () => undefined);
    }
    return removed;
  }

  /** With SNAPSHOTS_KEY set, encrypt state files saved before it was (returns their names). */
  async encryptPlaintext(): Promise<string[]> {
    if (!this.key) return [];
    await this.ensureDir();
    const names = (await readdir(this.dir)).filter((f) => f.endsWith('.state') && NAME.test(f.slice(0, -6))).map((f) => f.slice(0, -6));
    const done: string[] = [];
    for (const name of names) {
      await this.locked(name, async () => {
        const file = this.file(name, 'state');
        const raw = await this.readRegular(file, 2 * MAX_STATE_BYTES);
        const parsed = JSON.parse(raw);
        if (isEnvelope(parsed)) return;
        const state = parseState(parsed);
        if (!state) return;
        const body = await this.encrypt(name, JSON.stringify({ version: state.version, cookies: state.cookies, origins: state.origins }));
        await this.atomicWrite(name, file, body);
        const meta = await this.readMetaFile(name).catch(() => null);
        if (meta) await this.writeMeta({ ...meta, encrypted: true, bytes: Buffer.byteLength(body) });
        done.push(name);
      }).catch((err) => this.log.warn({ snapshot: name, err: (err as Error).message }, 'could not encrypt a saved snapshot'));
    }
    return done;
  }
}
