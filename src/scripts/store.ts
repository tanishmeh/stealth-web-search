import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Automation scripts on disk (SCRIPTS_DIR): `<name>.js` holds the code and `<name>.json` the
 * metadata (parameters, output, verification, run counts). Plain files, so they can be read,
 * edited, versioned or copied between machines.
 */

export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ScriptParam {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
  default?: unknown;
  example?: unknown;
}

export interface ScriptVerification {
  status: 'passed' | 'failed' | 'not_run';
  /** Script version the verification ran against. */
  version: number;
  at?: string;
  params?: Record<string, unknown>;
  durationMs?: number;
  /** Output preview (shortened). */
  output?: unknown;
  error?: string;
}

export interface ScriptMeta {
  name: string;
  version: number;
  description: string;
  /** The task the script was recorded for. */
  task?: string;
  params: ScriptParam[];
  output: { description: string; example?: unknown };
  createdAt: string;
  updatedAt: string;
  createdBy?: { runId: string; model?: string };
  verification: ScriptVerification;
  runs: number;
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'error';
}

export interface Script extends ScriptMeta {
  code: string;
}

export class ScriptError extends Error {}

/** Whether parsed metadata has the shape the server relies on (hand-edited or copied files may not). */
function validMeta(m: any, name: string): m is ScriptMeta {
  return (
    Boolean(m) &&
    typeof m === 'object' &&
    m.name === name &&
    typeof m.version === 'number' &&
    Array.isArray(m.params) &&
    m.params.every((p: any) => p && typeof p === 'object' && typeof p.name === 'string' && (PARAM_TYPES as readonly string[]).includes(p.type)) &&
    typeof m.verification?.status === 'string' &&
    typeof m.output === 'object' &&
    m.output !== null
  );
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'script';
}

export function validateName(name: string): string {
  if (!NAME.test(name)) {
    throw new ScriptError(`Invalid script name ${JSON.stringify(name)}: use 1-64 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  }
  return name;
}

/** Remove Markdown code fences a model may wrap around code. */
export function stripFences(code: string): string {
  const trimmed = code.trim();
  const m = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return m ? m[1] : trimmed;
}

/** Check and normalise parameter declarations. */
export function normalizeParams(input: unknown): ScriptParam[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ScriptError('params must be an array of {name, type, description, required, default?, example?}');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ScriptError(`params[${i}] must be an object`);
    const p = raw as Record<string, unknown>;
    const name = String(p.name ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new ScriptError(`params[${i}].name ${JSON.stringify(name)} must be a JavaScript identifier`);
    if (seen.has(name)) throw new ScriptError(`duplicate parameter ${JSON.stringify(name)}`);
    seen.add(name);
    const type = String(p.type ?? 'string').toLowerCase() as ParamType;
    if (!PARAM_TYPES.includes(type)) throw new ScriptError(`params[${i}].type must be one of ${PARAM_TYPES.join(', ')}`);
    const out: ScriptParam = {
      name,
      type,
      description: String(p.description ?? '').trim(),
      required: p.required === undefined ? p.default === undefined : Boolean(p.required),
    };
    if (p.default !== undefined) out.default = coerce(p.default, type, `default of ${name}`);
    if (p.example !== undefined) out.example = coerce(p.example, type, `example of ${name}`);
    return out;
  });
}

function coerce(value: unknown, type: ParamType, what: string): unknown {
  const fail = () => {
    throw new ScriptError(`${what} must be ${type === 'array' || type === 'object' ? `an ${type}` : `a ${type}`}, got ${JSON.stringify(value)}`);
  };
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return fail();
    case 'number':
    case 'integer': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail();
      if (type === 'integer' && !Number.isInteger(n)) return fail();
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return fail();
    case 'array':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // not JSON
        }
      }
      return fail();
    case 'object':
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      return fail();
    default:
      throw new ScriptError(`${what}: unknown parameter type ${JSON.stringify(type)}`);
  }
}

/** Apply defaults, coerce types and reject missing or unknown parameters. */
export function resolveParams(declared: ScriptParam[], given: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const input = given ?? {};
  const unknown = Object.keys(input).filter((k) => !declared.some((p) => p.name === k));
  if (unknown.length) {
    throw new ScriptError(`Unknown parameter(s): ${unknown.join(', ')}. The script takes: ${declared.map((p) => p.name).join(', ') || 'no parameters'}`);
  }
  const missing: string[] = [];
  for (const p of declared) {
    const value = input[p.name];
    if (value === undefined || value === null || value === '') {
      if (p.default !== undefined) out[p.name] = p.default;
      else if (p.required) missing.push(p.name);
      continue;
    }
    out[p.name] = coerce(value, p.type, `parameter ${p.name}`);
  }
  if (missing.length) throw new ScriptError(`Missing required parameter(s): ${missing.join(', ')}`);
  return out;
}

/** Example parameters (examples, else defaults), or null when a required one has neither. */
export function exampleParams(params: ScriptParam[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.example !== undefined) out[p.name] = p.example;
    else if (p.default !== undefined) out[p.name] = p.default;
    else if (p.required) return null;
  }
  return out;
}

export class ScriptStore {
  readonly dir: string;
  private ready: Promise<void> | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  private file(name: string, ext: 'js' | 'json'): string {
    return path.join(this.dir, `${validateName(name)}.${ext}`);
  }

  /** Serialize read-modify-write operations per script. */
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

  async list(): Promise<ScriptMeta[]> {
    await this.ensureDir();
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json') && NAME.test(f.slice(0, -5)));
    const metas: ScriptMeta[] = [];
    for (const f of files) {
      try {
        const m = JSON.parse(await readFile(path.join(this.dir, f), 'utf8'));
        // skip hand-edited or partial metadata instead of breaking the whole listing
        if (validMeta(m, f.slice(0, -5))) metas.push(m);
      } catch {
        // skip unreadable metadata
      }
    }
    return metas.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  /** Names of stored scripts whose metadata file is unreadable or invalid (script_list points them out). */
  async invalidNames(): Promise<string[]> {
    await this.ensureDir();
    const bad: string[] = [];
    for (const f of (await readdir(this.dir)).filter((x) => x.endsWith('.json') && NAME.test(x.slice(0, -5)))) {
      try {
        if (!validMeta(JSON.parse(await readFile(path.join(this.dir, f), 'utf8')), f.slice(0, -5))) bad.push(f.slice(0, -5));
      } catch {
        bad.push(f.slice(0, -5));
      }
    }
    return bad;
  }

  /** Whether either file of the script exists (even if its metadata is invalid). */
  async exists(name: string): Promise<boolean> {
    for (const ext of ['json', 'js'] as const) {
      try {
        await access(this.file(name, ext));
        return true;
      } catch {
        // try the other file
      }
    }
    return false;
  }

  async get(name: string): Promise<Script> {
    await this.ensureDir();
    let meta: ScriptMeta;
    let code: string;
    try {
      meta = JSON.parse(await readFile(this.file(name, 'json'), 'utf8'));
      code = (await readFile(this.file(name, 'js'), 'utf8')).replace(/\n$/, '');
      if (!validMeta(meta, name)) {
        const other = (meta as any)?.name;
        throw new ScriptError(
          typeof other === 'string' && other !== name
            ? `${name}.json says the script is named ${JSON.stringify(other)}: rename the files or fix the "name" field`
            : `The metadata of script ${JSON.stringify(name)} (${name}.json) is invalid: it needs name, version, params, output and verification`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const names = (await this.list()).map((s) => s.name);
        throw new ScriptError(`No script named ${JSON.stringify(name)}. Stored scripts: ${names.join(', ') || 'none'}`);
      }
      throw err;
    }
    return { ...meta, code };
  }

  /**
   * Create or replace a script; its version increases and its verification resets. With createOnly,
   * an existing script of that name is left alone and a ScriptError is thrown (checked atomically).
   */
  save(
    input: {
    name: string;
    description: string;
    task?: string;
    params: ScriptParam[];
    output: { description: string; example?: unknown };
    code: string;
    createdBy?: { runId: string; model?: string };
    },
    opts: { createOnly?: boolean } = {},
  ): Promise<Script> {
    const name = validateName(input.name);
    return this.locked(name, async () => {
      await this.ensureDir();
      // create-only: any file of that name counts, even one with broken metadata
      if (opts.createOnly && (await this.exists(name))) throw new ScriptError(`A script named ${JSON.stringify(name)} already exists`);
      let previous: Script | null = null;
      try {
        previous = await this.get(name);
      } catch {
        previous = null; // missing, or replaced on purpose (overwrite)
      }
      const now = new Date().toISOString();
      const version = (previous?.version ?? 0) + 1;
      const meta: ScriptMeta = {
        name,
        version,
        description: input.description,
        task: input.task ?? previous?.task,
        params: input.params,
        output: input.output,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        createdBy: input.createdBy ?? previous?.createdBy,
        verification: { status: 'not_run', version },
        runs: previous?.runs ?? 0,
        lastRunAt: previous?.lastRunAt,
        lastRunStatus: previous?.lastRunStatus,
      };
      await atomicWrite(this.file(name, 'js'), `${input.code.trimEnd()}\n`);
      await atomicWrite(this.file(name, 'json'), `${JSON.stringify(meta, null, 2)}\n`);
      return { ...meta, code: input.code };
    });
  }

  /** Record a verification result for a specific version (ignored if the script changed since). */
  setVerification(name: string, verification: ScriptVerification): Promise<void> {
    return this.locked(name, async () => {
      const script = await this.get(name);
      if (script.version !== verification.version) return;
      const { code: _code, ...meta } = script;
      meta.verification = verification;
      await atomicWrite(this.file(name, 'json'), `${JSON.stringify(meta, null, 2)}\n`);
    });
  }

  recordRun(name: string, status: 'ok' | 'error'): Promise<void> {
    return this.locked(name, async () => {
      const script = await this.get(name);
      const { code: _code, ...meta } = script;
      meta.runs = (meta.runs ?? 0) + 1;
      meta.lastRunAt = new Date().toISOString();
      meta.lastRunStatus = status;
      await atomicWrite(this.file(name, 'json'), `${JSON.stringify(meta, null, 2)}\n`);
    });
  }

  delete(name: string): Promise<void> {
    return this.locked(name, async () => {
      // works for scripts with broken metadata too, so they can be cleaned up
      if (!(await this.exists(name))) {
        const names = (await this.list()).map((s) => s.name);
        throw new ScriptError(`No script named ${JSON.stringify(name)}. Stored scripts: ${names.join(', ') || 'none'}`);
      }
      await rm(this.file(name, 'js'), { force: true });
      await rm(this.file(name, 'json'), { force: true });
    });
  }

  /** A name that is free, based on `base` (base, base-2, base-3, …). */
  async freeName(base: string): Promise<string> {
    const root = NAME.test(base) ? base : slugify(base);
    if (!(await this.exists(root))) return root;
    const stem = root.slice(0, 58).replace(/[-_]+$/, '');
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem}-${i}`;
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new ScriptError(`No free script name based on ${JSON.stringify(base)}`);
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}
