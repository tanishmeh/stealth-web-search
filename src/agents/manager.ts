import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Browser } from '../browser/browser.ts';
import type { BrowserRegistry } from '../browser/registry.ts';
import type { Logger } from '../logger.ts';
import type { McpDeps } from '../mcp/server.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { summarize } from '../util/summarize.ts';
import { KINDS } from './kinds.ts';
import { ChatClient, LlmAbortedError } from './llm.ts';
import { AgentRun, runAgentLoop, type AgentInput, type AgentKind, type RunEnv } from './run.ts';

const MAX_QUEUED = 20;
const KEEP_RUNS = 100;
const KEEP_TRANSCRIPTS = 300;

export class AgentBusyError extends Error {}

/**
 * Starts and tracks sub-agent runs. Each run gets its own isolated browser (a separate Obscura
 * CDP connection: own tabs, cookies and storage), visible on the dashboard, and talks to the
 * configured OpenAI-compatible model. At most AGENT_MAX_CONCURRENT runs work at once; the rest
 * wait in order.
 */
export class AgentManager {
  readonly llm: ChatClient;
  private readonly deps: McpDeps;
  private readonly obscura: ObscuraProcess;
  private readonly registry: BrowserRegistry;
  private readonly log: Logger;
  private readonly runs = new Map<string, AgentRun>();
  private readonly queue: AgentRun[] = [];
  private running = 0;
  private shuttingDown = false;
  private readonly transcriptDir: string;

  constructor(deps: McpDeps, obscura: ObscuraProcess, registry: BrowserRegistry) {
    this.deps = deps;
    this.obscura = obscura;
    this.registry = registry;
    this.log = deps.log.child({ component: 'agent' });
    this.llm = new ChatClient(deps.config.agent, deps.log);
    this.transcriptDir = path.join(deps.config.log.dir, 'agent-runs');
  }

  start(kind: AgentKind, input: AgentInput, client: string | null): AgentRun {
    if (this.shuttingDown) throw new AgentBusyError('The server is shutting down; no new agent runs are accepted.');
    if (this.queue.length >= MAX_QUEUED) {
      throw new AgentBusyError(`Too many agent runs are waiting (${this.queue.length}). Wait for some to finish (agent_status) or cancel them (agent_cancel).`);
    }
    const run = new AgentRun(`r${randomUUID().replace(/-/g, '').slice(0, 7)}`, kind, input, client);
    this.runs.set(run.id, run);
    this.prune();
    run.onUpdate(() => this.deps.hub.publishAgent(run.summary()));
    this.log.info(
      {
        runId: run.id,
        kind,
        client,
        input: summarize(input, { maxString: 1_000 }),
        queuePosition: this.running >= this.deps.config.agent.maxConcurrent ? this.queue.length + 1 : 0,
      },
      `agent run ${run.id} (${kind}) created`,
    );
    this.queue.push(run);
    run.activity = this.running >= this.deps.config.agent.maxConcurrent ? `queued (position ${this.queue.length})` : 'starting';
    run.update();
    this.pump();
    return run;
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id.trim());
  }

  /** Most recent first. */
  list(): AgentRun[] {
    return [...this.runs.values()].reverse();
  }

  get activeCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Wait until the run is done, `ms` pass, or `signal` aborts. `onProgress` is called when the
   * step changes and every few seconds while it thinks.
   */
  async wait(run: AgentRun, ms: number, onProgress?: (run: AgentRun) => void, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      let lastStep = -1;
      let lastAt = 0;
      const finish = () => {
        clearTimeout(timer);
        clearInterval(beat);
        off();
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      // a heartbeat while nothing visible changes (prompt processing, long tool calls, waiting in the queue)
      const beat = setInterval(() => {
        if (onProgress && !run.done) onProgress(run);
      }, 10_000);
      const off = run.onUpdate((r) => {
        if (r.done) return;
        if (onProgress && (r.step !== lastStep || Date.now() - lastAt > 5_000)) {
          lastStep = r.step;
          lastAt = Date.now();
          onProgress(r);
        }
      });
      if (signal?.aborted) return finish();
      signal?.addEventListener('abort', finish, { once: true });
      void run.settled.then(finish);
      if (onProgress && !run.done) {
        // report where the run stands right away, not only at its next step
        lastStep = run.step;
        lastAt = Date.now();
        onProgress(run);
      }
    });
  }

  cancel(id: string, reason = 'cancelled by the host'): AgentRun | null {
    const run = this.get(id);
    if (!run || run.done) return run ?? null;
    const queued = this.queue.indexOf(run);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      run.finish('cancelled', reason);
      run.settle();
      this.log.info({ runId: run.id }, `agent run ${run.id} cancelled while queued`);
      return run;
    }
    run.error = reason;
    run.abort.abort();
    this.log.info({ runId: run.id }, `cancelling agent run ${run.id}`);
    return run;
  }

  private pump(): void {
    while (this.running < this.deps.config.agent.maxConcurrent && this.queue.length > 0) {
      const run = this.queue.shift()!;
      this.running++;
      void this.execute(run).finally(() => {
        this.running--;
        this.queue.forEach((r, i) => {
          r.activity = `queued (position ${i + 1})`;
          r.update();
        });
        this.pump();
      });
    }
  }

  private async execute(run: AgentRun): Promise<void> {
    const { config } = this.deps;
    const spec = KINDS[run.kind];
    const log = this.log.child({ runId: run.id, kind: run.kind });
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.activity = 'starting';
    const browser = new Browser(config, this.deps.log, this.obscura, this.deps.hub, { id: `agent-${run.id}` });
    run.browserId = browser.id;
    this.registry.add(browser, { label: `${spec.label[0].toUpperCase()}${spec.label.slice(1)} agent ${run.id}`, kind: 'agent', runId: run.id });
    run.update();
    const env: RunEnv = { deps: this.deps, config, llm: this.llm, browser, log, forced: false };
    log.info({ browserId: browser.id, maxSteps: run.input.maxSteps }, `agent run ${run.id} started`);
    try {
      await runAgentLoop(run, spec, env);
      await spec.finalize?.(run, env);
      run.finish(run.outcome ? 'completed' : 'failed', run.outcome ? null : 'the agent ended without a result');
    } catch (err) {
      if (spec.finalize && !run.abort.signal.aborted) await spec.finalize(run, env).catch(() => undefined);
      if (err instanceof LlmAbortedError || run.abort.signal.aborted) run.finish('cancelled', run.error ?? 'cancelled');
      else {
        log.error({ err: (err as Error).message }, `agent run ${run.id} failed`);
        run.finish('failed', (err as Error).message);
      }
    } finally {
      // a cancelled run may still have a browser call running: closing the browser ends it
      await browser.dispose().catch(() => undefined);
      this.registry.close(browser.id);
    }
    log.info(
      {
        status: run.status,
        success: run.outcome?.success ?? null,
        steps: run.step,
        durationMs: run.durationMs,
        usage: run.usage,
        compactions: run.compactions,
        error: run.error,
        outcome: summarize(run.outcome, { maxString: 1_000 }),
        sources: run.sources.map((s) => s.url),
        script: run.scriptName ? { name: run.scriptName, version: run.scriptVersion, tests: run.tests.map((t) => t.ok) } : undefined,
      },
      `agent run ${run.id} ${run.status} (${run.step} steps, ${Math.round(run.durationMs / 1000)} s)`,
    );
    if (config.agent.transcripts) await this.writeTranscript(run).catch((err) => log.warn({ err: (err as Error).message }, 'could not write the agent transcript'));
    run.compact();
    run.update();
    run.settle();
  }

  private async writeTranscript(run: AgentRun): Promise<void> {
    await mkdir(this.transcriptDir, { recursive: true });
    const stamp = run.createdAt.replace(/[:.]/g, '-');
    const file = path.join(this.transcriptDir, `${stamp}_${run.kind}_${run.id}.json`);
    const body = {
      summary: run.summary(),
      input: run.input,
      outcome: run.outcome,
      error: run.error,
      notes: run.notes,
      sources: run.sources,
      visited: [...run.visited.entries()].map(([url, v]) => ({ url, ...v })),
      script: run.scriptName ? { name: run.scriptName, version: run.scriptVersion, tests: run.tests } : null,
      steps: run.steps,
      // tool-call arguments as logged: values typed into password-like fields stay masked
      messages: run.messages.map((m) =>
        m.tool_calls?.some((c) => run.redactedCalls.has(c.id))
          ? { ...m, tool_calls: m.tool_calls.map((c) => (run.redactedCalls.has(c.id) ? { ...c, function: { ...c.function, arguments: run.redactedCalls.get(c.id)! } } : c)) }
          : m,
      ),
    };
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    run.transcriptFile = file;
    const files = (await readdir(this.transcriptDir)).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_TRANSCRIPTS))) {
      await rm(path.join(this.transcriptDir, old), { force: true }).catch(() => undefined);
    }
  }

  private prune(): void {
    if (this.runs.size <= KEEP_RUNS) return;
    for (const [id, run] of this.runs) {
      if (this.runs.size <= KEEP_RUNS) break;
      if (run.done) this.runs.delete(id);
    }
  }

  /** Refuse new runs and cancel running and queued ones (synchronous; shutdown() then waits for them). */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const run of [...this.queue]) this.cancel(run.id, 'the server is shutting down');
    for (const run of this.runs.values()) if (!run.done) this.cancel(run.id, 'the server is shutting down');
  }

  async shutdown(budgetMs = 4_000): Promise<void> {
    this.beginShutdown();
    await Promise.race([
      Promise.allSettled([...this.runs.values()].map((r) => r.settled)),
      new Promise((r) => setTimeout(r, budgetMs)),
    ]);
  }
}
