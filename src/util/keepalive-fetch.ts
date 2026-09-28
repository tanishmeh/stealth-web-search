/**
 * A fetch whose keep-alive connections are reused without waiting for a timer, for the stdio bridge.
 *
 * Node 24.17.0 to 24.20.0 bundle undici 7.28.0 or 7.29.0. Before that undici reuses an idle
 * keep-alive socket it checks whether the server closed it (GHSA-35p6-xmwp-9g52), and it waits for
 * a setTimeout(0) to do so: at least one ~1 ms timer tick on every sequential request. undici
 * 7.29.1 (Node 24.21.0) does the same check with setImmediate (nodejs/undici#5493). The bridge
 * relays every tool call over one keep-alive connection, so on the affected Node versions each call
 * paid about 1.5 ms extra (measured relay p50 1.7-1.9 ms, 0.3-0.4 ms with this fix).
 *
 * On those versions keepAliveFetch() returns a fetch that routes requests through an Agent from the
 * undici package (the fixed version). Everything else stays Node's own fetch (redirects, content
 * decoding, streaming bodies, abort, errors); only the connection pool changes. On every other
 * Node version it returns undefined and callers keep the global fetch as is. So it does when a
 * dispatcher is already installed when it is called: Node creates its own default on the first
 * fetch, so one that exists before was chosen on purpose (the proxy agent of NODE_USE_ENV_PROXY, or
 * an Agent with custom TLS options set up with --import) and stays in charge.
 */
import type { Dispatcher } from 'undici';

/** Where every copy of undici, Node's bundled one included, keeps the dispatcher the global fetch uses. */
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/** undici versions whose keep-alive reuse waits for a timer tick: 7.28.0 and 7.29.0. */
export function hasSlowKeepAlive(undiciVersion: string | undefined): boolean {
  const match = /^7\.(\d+)\.(\d+)$/.exec(undiciVersion ?? '');
  if (!match) return false;
  const minor = Number(match[1]);
  const patch = Number(match[2]);
  return minor === 28 || (minor === 29 && patch === 0);
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface KeepAliveFetch {
  /** Node's fetch, sent through undici's Agent once load() has finished (before that, as is). */
  fetch: FetchFn;
  /**
   * Load undici's Agent after `delayMs` (its import takes ~30 ms of the event loop, so the caller
   * starts it after the handshake instead of at startup). Resolves true when the Agent is in use,
   * false when it is not (a proxy or a dispatcher set up by someone else stays in charge, or the
   * import failed). Loads once; later calls return the same promise.
   */
  load(delayMs?: number): Promise<boolean>;
}

export interface KeepAliveFetchOptions {
  /** Defaults to the bundled undici (process.versions.undici). */
  undiciVersion?: string;
  /** Defaults to the global fetch. */
  fetch?: FetchFn;
  /** Defaults to the process-wide dispatcher of the global fetch. */
  globalDispatcher?: () => unknown;
}

/** Call it before the process's first fetch: a dispatcher that exists by then was installed on purpose. */
export function keepAliveFetch(options: KeepAliveFetchOptions = {}): KeepAliveFetch | undefined {
  if (!hasSlowKeepAlive(options.undiciVersion ?? process.versions.undici)) return undefined;
  const globalDispatcher = options.globalDispatcher ?? (() => (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER]);
  if (globalDispatcher() !== undefined) return undefined;
  const baseFetch: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  let dispatcher: Dispatcher | undefined;
  let loading: Promise<boolean> | null = null;

  return {
    fetch: (input, init) => baseFetch(input, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init),
    load(delayMs = 0) {
      loading ??= (async () => {
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs).unref());
        // By now the global fetch has run and Node has made its default, a plain Agent. Anything else
        // was installed since keepAliveFetch() was called, on purpose: keep it.
        const current = globalDispatcher() as { constructor?: { name?: string } } | undefined;
        if (current !== undefined && current?.constructor?.name !== 'Agent') return false;
        const { Agent } = await import('undici');
        dispatcher = new Agent();
        return true;
      })().catch(() => false);
      return loading;
    },
  };
}
