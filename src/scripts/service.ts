import { randomUUID } from 'node:crypto';
import { Browser } from '../browser/browser.ts';
import type { BrowserRegistry } from '../browser/registry.ts';
import type { Logger } from '../logger.ts';
import { redactParams, type McpDeps } from '../mcp/server.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { summarize } from '../util/summarize.ts';
import { SCRIPT_METHODS, createScriptHost } from './api.ts';
import { runInSandbox } from './sandbox.ts';
import { ScriptStore, resolveParams, type Script } from './store.ts';

export interface ScriptRunResult {
  runId: string;
  script: { name: string; version: number };
  params: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  /** browser.* calls made. */
  calls: number;
  finalUrl: string | null;
  browserId: string;
}

export interface ScriptRunOptions {
  /** Label in logs and on the dashboard. */
  client?: string;
  agentRunId?: string;
  signal?: AbortSignal;
  /** Count the run in the script's statistics (false for the automation agent's own tests). */
  record?: boolean;
  onProgress?: (message: string) => void;
}

const MAX_LOG_LINES = 300;
const MAX_LOG_CHARS = 60_000;
const MAX_CONCURRENT_RUNS = 4;

/** Counting semaphore: at most `n` script runs at a time, the rest wait in order. */
class Slots {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(n: number) {
    this.free = n;
  }
  async take(signal?: AbortSignal): Promise<() => void> {
    if (this.free > 0) this.free--;
    else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.waiters.indexOf(grant);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('the script run was cancelled'));
        };
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(grant);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/**
 * Stored automation scripts: the store plus running a script in a fresh, isolated browser
 * (its own tabs and cookies, disposed afterwards), watchable on the dashboard.
 */
export class ScriptService {
  readonly store: ScriptStore;
  private readonly deps: McpDeps;
  private readonly obscura: ObscuraProcess;
  private readonly registry: BrowserRegistry;
  private readonly log: Logger;
  private readonly slots = new Slots(MAX_CONCURRENT_RUNS);
  /** Runs in progress, so shutdown can wait for them. */
  readonly active = new Set<Promise<unknown>>();
  /** Stops every run at shutdown. */
  private readonly stopAll = new AbortController();
  private shuttingDown = false;

  constructor(deps: McpDeps, obscura: ObscuraProcess, registry: BrowserRegistry) {
    this.deps = deps;
    this.obscura = obscura;
    this.registry = registry;
    this.store = new ScriptStore(deps.config.scripts.dir);
    this.log = deps.log.child({ component: 'script' });
  }

  async run(nameOrScript: string | Script, params: Record<string, unknown> | undefined, opts: ScriptRunOptions = {}): Promise<ScriptRunResult> {
    if (this.shuttingDown) throw new Error('The server is shutting down');
    const script = typeof nameOrScript === 'string' ? await this.store.get(nameOrScript) : nameOrScript;
    const resolved = resolveParams(script.params, params);
    const signal = opts.signal ? AbortSignal.any([opts.signal, this.stopAll.signal]) : this.stopAll.signal;
    const release = await this.slots.take(signal);
    if (signal.aborted) {
      release();
      throw new Error('the script run was cancelled');
    }
    const task = this.execute(script, resolved, { ...opts, signal }).finally(release);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => undefined);
    return task;
  }

  private async execute(script: Script, params: Record<string, unknown>, opts: ScriptRunOptions): Promise<ScriptRunResult> {
    const { config } = this.deps;
    const runId = randomUUID().slice(0, 8);
    const browserId = `script-${runId}`;
    const client = opts.client ?? `script:${script.name}`;
    const log = this.log.child({ script: script.name, version: script.version, scriptRunId: runId, browserId, ...(opts.agentRunId ? { agentRunId: opts.agentRunId } : {}) });
    const browser = new Browser(config, this.deps.log, this.obscura, this.deps.hub, { id: browserId });
    this.registry.add(browser, { label: `Script ${script.name}`, kind: 'script', runId });
    const logs: string[] = [];
    let logChars = 0;
    let omitted = 0;
    const onLog = (line: string) => {
      // kept lines go to the result and the server log; the rest are only counted
      if (logs.length >= MAX_LOG_LINES || logChars > MAX_LOG_CHARS) {
        if (omitted++ === 0) {
          logs.push('…[more log lines omitted]');
          log.info('further script log lines omitted');
        }
        return;
      }
      const clipped = line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line;
      log.info({ line: clipped }, 'script log');
      logs.push(clipped);
      logChars += clipped.length;
    };
    const started = Date.now();
    const shownParams = config.log.redactSecrets ? redactParams(params) : params;
    log.info({ params: summarize(shownParams, { maxString: 300 }), client }, `script run started: ${script.name} v${script.version}`);
    // stops browser calls that are still queued once the script ends, times out or is cancelled
    const runAbort = new AbortController();
    const onCancel = () => runAbort.abort();
    opts.signal?.addEventListener('abort', onCancel, { once: true });
    let result: ScriptRunResult;
    try {
      const host = createScriptHost({
        deps: this.deps,
        browser,
        client,
        agentRunId: opts.agentRunId,
        onLog,
        onCall: (method) => opts.onProgress?.(`browser.${method}`),
        signal: runAbort.signal,
      });
      const outcome = await runInSandbox(script.code, params, host, {
        timeoutMs: config.scripts.timeoutMs,
        memoryBytes: config.scripts.memoryBytes,
        methods: SCRIPT_METHODS,
        signal: opts.signal,
      });
      result = {
        runId,
        script: { name: script.name, version: script.version },
        params,
        ok: outcome.ok,
        ...(outcome.ok ? { output: outcome.value } : { error: outcome.error }),
        logs,
        durationMs: Date.now() - started,
        calls: outcome.calls,
        finalUrl: browser.activeTab?.url ?? null,
        browserId,
      };
    } catch (err) {
      result = {
        runId,
        script: { name: script.name, version: script.version },
        params,
        ok: false,
        error: (err as Error).message,
        logs,
        durationMs: Date.now() - started,
        calls: 0,
        finalUrl: browser.activeTab?.url ?? null,
        browserId,
      };
    } finally {
      runAbort.abort();
      opts.signal?.removeEventListener('abort', onCancel);
      // closing the browser right away also fails a browser call that a stopped script left running
      await browser.dispose().catch(() => undefined);
      this.registry.close(browserId);
    }
    result.durationMs = Date.now() - started;
    log.info(
      { ok: result.ok, durationMs: result.durationMs, calls: result.calls, error: result.error, logLinesOmitted: omitted || undefined, output: summarize(result.output, { maxString: 500 }) },
      `script run ${result.ok ? 'finished' : 'failed'}: ${script.name} (${result.durationMs} ms)`,
    );
    if (opts.record !== false) await this.store.recordRun(script.name, result.ok ? 'ok' : 'error').catch(() => undefined);
    return result;
  }

  /** Refuse new runs and stop running ones (synchronous; shutdown() then waits for them). */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.stopAll.abort();
  }

  async shutdown(budgetMs = 4_000): Promise<void> {
    this.beginShutdown();
    await Promise.race([Promise.allSettled([...this.active]), new Promise((r) => setTimeout(r, budgetMs))]);
  }
}

