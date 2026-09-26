import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';

/**
 * Runs automation scripts in QuickJS compiled to WebAssembly: a separate JavaScript engine with
 * no Node.js APIs at all (no require, process, fs, network or timers). The only way out is the
 * `browser` API, whose calls go through the same browser tools (and URL/SSRF guards) as an
 * agent's. Every run gets a fresh engine instance with memory, stack and time limits.
 */

export interface SandboxHost {
  /** Perform one `browser.<method>(...args)` call. The result must be JSON-serializable. */
  call(method: string, args: unknown[]): Promise<unknown>;
  /** One line from log()/console.log(). */
  log(line: string): void;
}

export interface SandboxOptions {
  timeoutMs: number;
  memoryBytes: number;
  /** Host methods exposed as browser.<name>(...). */
  methods: readonly string[];
  /** Upper bound on browser calls, against runaway loops. */
  maxCalls?: number;
  signal?: AbortSignal;
}

export type SandboxResult = { ok: true; value: unknown; calls: number } | { ok: false; error: string; calls: number };

const FILENAME = 'script.js';
/** Longest stretch of script computation between two browser calls (the server's event loop is shared). */
const SLICE_MS = 500;

function prelude(methods: readonly string[]): string {
  const forwarders = methods
    .filter((m) => m !== 'evaluate')
    .map((m) => `  ${m}: (...args) => __call(${JSON.stringify(m)}, args),`)
    .join('\n');
  return `'use strict';
const __call = (method, args) => __host(method, JSON.stringify(args === undefined ? [] : args)).then((t) => (t === undefined || t === '' ? undefined : JSON.parse(t)));
const __src = (fn, args) => '(' + String(fn) + ')(' + args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ') + ')';
const __fmt = (a) => { if (typeof a === 'string') return a; if (a instanceof Error) return String(a); try { return JSON.stringify(a); } catch (e) { return String(a); } };
globalThis.browser = Object.freeze({
${forwarders}
  evaluate: (code, ...args) => __call('evaluate', [typeof code === 'function' ? __src(code, args) : String(code)]),
});
globalThis.log = (...a) => __log(a.map(__fmt).join(' '));
globalThis.console = Object.freeze({ log: globalThis.log, info: globalThis.log, warn: globalThis.log, error: globalThis.log, debug: globalThis.log });
globalThis.sleep = (ms) => __call('sleep', [ms]);
globalThis.params = JSON.parse(__paramsJson);
`;
}

const START = `(async () => {
  if (typeof run !== 'function') throw new Error('The script must define: async function run(params) { ... }');
  const result = await run(globalThis.params);
  return JSON.stringify(result === undefined ? null : result);
})()`;

function describeError(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const err = ctx.dump(handle) as any;
  if (err && typeof err === 'object') {
    const head =
      err.message === undefined ? JSON.stringify(err) : err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : String(err.message);
    const frames = typeof err.stack === 'string' ? err.stack.split('\n').map((l: string) => l.trim()).filter((l: string) => l.includes(FILENAME)).slice(0, 3) : [];
    return frames.length ? `${head} (${frames.join('; ')})` : head;
  }
  return String(err);
}

/** Syntax check without running anything; returns the error message, or null when the code compiles. */
export async function checkSyntax(code: string): Promise<string | null> {
  const mod = await newQuickJSWASMModuleFromVariant(variant as any);
  const ctx = mod.newContext();
  try {
    const res = ctx.evalCode(code, FILENAME, { compileOnly: true });
    if (res.error) {
      const msg = describeError(ctx, res.error);
      res.error.dispose();
      return msg;
    }
    res.value.dispose();
    if (!/\basync\s+function\s+run\s*\(|\b(?:const|let|var)\s+run\s*=\s*async\b/.test(code)) {
      return 'The script must define: async function run(params) { ... }';
    }
    return null;
  } finally {
    ctx.dispose();
  }
}

export async function runInSandbox(code: string, params: Record<string, unknown>, host: SandboxHost, opts: SandboxOptions): Promise<SandboxResult> {
  if (opts.signal?.aborted) return { ok: false, error: 'the script run was cancelled', calls: 0 };
  const mod = await newQuickJSWASMModuleFromVariant(variant as any);
  const rt = mod.newRuntime();
  rt.setMemoryLimit(opts.memoryBytes);
  // well below what the host's own (native) stack allows, so deep recursion fails inside the script
  rt.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + opts.timeoutMs;
  let stopped = false;
  // Script code runs on the server's event loop: a stretch of computation without awaiting a
  // browser call is limited, so an endless loop cannot freeze the server for the whole timeout.
  let sliceStart = 0;
  let sliceExceeded = false;
  rt.setInterruptHandler(() => {
    if (stopped || Date.now() > deadline) return true;
    if (sliceStart && Date.now() - sliceStart > SLICE_MS) {
      sliceExceeded = true;
      return true;
    }
    return false;
  });
  const ctx = rt.newContext();
  const deferreds = new Set<QuickJSDeferredPromise>();
  const inFlight = new Set<Promise<void>>();
  const maxCalls = opts.maxCalls ?? 5_000;
  let calls = 0;
  let disposed = false;
  /** Set when the engine threw into the host (e.g. native stack overflow): its state is not trusted any more. */
  let broken: string | null = null;
  let onBroken: ((message: string) => void) | null = null;

  /** Run engine code with the slice clock on; a host-level exception marks the engine broken. */
  const guarded = <T>(fn: () => T): T | undefined => {
    sliceStart = Date.now();
    try {
      return fn();
    } catch (err) {
      stopped = true;
      broken = /stack|recursion/i.test(String((err as Error)?.message)) ? 'the script exceeded the stack (recursion too deep)' : `the script engine failed: ${(err as Error)?.message ?? err}`;
      onBroken?.(broken);
      return undefined;
    } finally {
      sliceStart = 0;
    }
  };

  const pump = () => {
    if (disposed || broken) return;
    const res = guarded(() => rt.executePendingJobs());
    if (res && res.error) res.error.dispose();
  };

  const explain = (message: string): string => {
    if (sliceExceeded) return `the script computed for more than ${SLICE_MS / 1000} s without waiting for a browser call (an endless loop?)`;
    if (/interrupted/i.test(message) && Date.now() > deadline) return `the script did not finish within ${Math.round(opts.timeoutMs / 1000)} s`;
    return message;
  };

  const hostFn = ctx.newFunction('__host', (methodH, argsH) => {
    const method = ctx.getString(methodH);
    const argsJson = ctx.getString(argsH);
    const deferred = ctx.newPromise();
    deferreds.add(deferred);
    const settle = async () => {
      // never settle synchronously: the handle must first be returned to the engine
      await Promise.resolve();
      let value: unknown;
      let failure: string | null = null;
      try {
        if (stopped) throw new Error('the script was stopped');
        if (++calls > maxCalls) throw new Error(`too many browser calls (more than ${maxCalls})`);
        value = await host.call(method, JSON.parse(argsJson));
      } catch (err) {
        failure = (err as Error)?.message ?? String(err);
      }
      if (disposed || broken) return;
      if (stopped) {
        // the run already ended (timeout, cancel): do not resume the script
        deferreds.delete(deferred);
        deferred.dispose();
        return;
      }
      if (failure !== null) {
        const e = ctx.newError(failure);
        deferred.reject(e);
        e.dispose();
      } else {
        const text = value === undefined ? undefined : JSON.stringify(value);
        const h = text === undefined ? ctx.undefined : ctx.newString(text);
        deferred.resolve(h);
        if (text !== undefined) h.dispose();
      }
      deferreds.delete(deferred);
      deferred.dispose();
      pump();
    };
    const p = settle().finally(() => inFlight.delete(p));
    inFlight.add(p);
    return deferred.handle;
  });
  ctx.setProp(ctx.global, '__host', hostFn);
  hostFn.dispose();

  const logFn = ctx.newFunction('__log', (lineH) => {
    try {
      host.log(ctx.getString(lineH));
    } catch {
      // logging must not break the script
    }
  });
  ctx.setProp(ctx.global, '__log', logFn);
  logFn.dispose();

  const paramsH = ctx.newString(JSON.stringify(params ?? {}));
  ctx.setProp(ctx.global, '__paramsJson', paramsH);
  paramsH.dispose();

  const teardown = async () => {
    stopped = true;
    // let host calls that are still running (bounded by tool timeouts) finish before freeing the engine
    if (inFlight.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => (timer = setTimeout(r, 60_000)))]);
      clearTimeout(timer);
    }
    disposed = true;
    if (broken) return; // a broken engine is dropped, not disposed
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {
        // already disposed
      }
    }
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      // a leaked handle only leaks memory of this (discarded) engine instance
    }
  };

  /** Describe a thrown value; script getters or toJSON run here, so the slice clock is on. */
  const describe = (handle: QuickJSHandle): string => explain(guarded(() => describeError(ctx, handle)) ?? broken ?? 'the script failed');

  const evalStep = (source: string, filename: string): QuickJSHandle | string => {
    const res = guarded(() => ctx.evalCode(source, filename));
    if (!res) return broken ?? 'the script engine failed';
    if (res.error) {
      const msg = describe(res.error);
      res.error.dispose();
      return msg;
    }
    return res.value;
  };

  let settledEarly: SandboxResult | null = null;
  for (const [source, filename] of [
    [prelude(opts.methods), 'prelude.js'],
    [code, FILENAME],
  ] as const) {
    const out = evalStep(source, filename);
    if (typeof out === 'string') {
      settledEarly = { ok: false, error: out, calls };
      break;
    }
    out.dispose();
  }
  if (settledEarly) {
    await teardown();
    return settledEarly;
  }

  const started = evalStep(START, 'start.js');
  if (typeof started === 'string') {
    await teardown();
    return { ok: false, error: started, calls };
  }
  const native = ctx.resolvePromise(started);
  started.dispose();

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<SandboxResult>((resolve) => {
    onBroken = (message) => resolve({ ok: false, error: message, calls });
    timer = setTimeout(() => {
      stopped = true;
      resolve({ ok: false, error: `the script did not finish within ${Math.round(opts.timeoutMs / 1000)} s`, calls });
    }, Math.max(0, deadline - Date.now()));
    if (opts.signal) {
      onAbort = () => {
        stopped = true;
        resolve({ ok: false, error: 'the script run was cancelled', calls });
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const finished = native.then((res): SandboxResult => {
    if (broken) return { ok: false, error: broken, calls };
    if (res.error) {
      const msg = describe(res.error);
      res.error.dispose();
      return { ok: false, error: msg, calls };
    }
    const text = ctx.getString(res.value);
    res.value.dispose();
    try {
      return { ok: true, value: JSON.parse(text), calls };
    } catch {
      return { ok: false, error: 'the script returned a value that is not JSON-serializable', calls };
    }
  });
  pump();
  const result = broken ? { ok: false as const, error: broken as string, calls } : await Promise.race([finished, limit]);
  clearTimeout(timer);
  if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  finished.catch(() => undefined);
  // tear down in the background when the script is stopped mid-call; right away otherwise
  const done = teardown();
  if (result.ok || inFlight.size === 0) await done;
  else void done;
  return result;
}
