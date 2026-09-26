import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Browser } from '../browser/browser.ts';
import { ToolError } from '../browser/errors.ts';
import type { BrowserRegistry } from '../browser/registry.ts';
import type { Logger } from '../logger.ts';
import type { McpDeps } from '../mcp/server.ts';
import type { ObscuraProcess } from '../obscura/process.ts';
import { SnapshotConflictError, SnapshotEmptyError, SnapshotSignedOutError, domainsText } from '../snapshots/service.ts';
import { SnapshotError, SnapshotNotFoundError } from '../snapshots/store.ts';
import { MAX_WAITING } from '../util/limits.ts';
import { summarize } from '../util/summarize.ts';
import { inlineJson, replyArguments } from './format.ts';
import { KINDS } from './kinds.ts';
import { ChatClient, LlmAbortedError } from './llm.ts';
import { AgentRun, runAgentLoop, type AgentInput, type AgentKind, type AgentQuestion, type RunEnv, type RunStatus } from './run.ts';

export { MAX_WAITING };

const MAX_QUEUED = 20;
const KEEP_RUNS = 100;
const KEEP_TRANSCRIPTS = 300;
const DELETED_DURING_RUN = 'the user deleted it during the run';

export class AgentBusyError extends Error {}

/**
 * Starts and tracks sub-agent runs. Each run gets its own isolated browser (a separate Obscura
 * CDP connection: own tabs, cookies and storage), visible on the dashboard, and talks to the
 * configured OpenAI-compatible model. At most AGENT_MAX_CONCURRENT runs work at once; the rest
 * wait in order. A run paused on a question to the host gives its slot up (keeping its browser) and
 * gets one back, ahead of the queue, once the question is answered or expires.
 */
export class AgentManager {
  readonly llm: ChatClient;
  private readonly deps: McpDeps;
  private readonly obscura: ObscuraProcess;
  private readonly registry: BrowserRegistry;
  private readonly log: Logger;
  private readonly runs = new Map<string, AgentRun>();
  private readonly queue: AgentRun[] = [];
  /** Runs holding one of the AGENT_MAX_CONCURRENT slots. */
  private readonly holders = new Set<AgentRun>();
  /** Paused runs whose question closed, waiting for a slot: served before the queue. */
  private readonly resumeWaiters: Array<{ run: AgentRun; grant: () => void }> = [];
  private shuttingDown = false;
  private readonly transcriptDir: string;

  constructor(deps: McpDeps, obscura: ObscuraProcess, registry: BrowserRegistry) {
    this.deps = deps;
    this.obscura = obscura;
    this.registry = registry;
    this.log = deps.log.child({ component: 'agent' });
    this.llm = new ChatClient(deps.config.agent, deps.log);
    this.transcriptDir = path.join(deps.config.log.dir, 'agent-runs');
    // a snapshot the user deleted is never saved again by a run that uses it, and never reported as saved
    deps.snapshots?.on('deleted', (name: string) => {
      for (const run of this.runs.values()) {
        if (run.done || (run.snapshot?.name !== name && run.snapshotSaved?.name !== name)) continue;
        run.deletedSnapshots.add(name);
        if (this.reportDeleted(run)) run.update();
      }
    });
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
        queuePosition: this.holders.size >= this.deps.config.agent.maxConcurrent ? this.queue.length + 1 : 0,
      },
      `agent run ${run.id} (${kind}) created`,
    );
    this.queue.push(run);
    run.activity = this.holders.size >= this.deps.config.agent.maxConcurrent ? `queued (position ${this.queue.length})` : 'starting';
    run.update();
    this.pump();
    return run;
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id.trim());
  }

  /**
   * A sign-in the run saved (or refreshed) that the user deleted during the run is reported as not
   * saved: the host must not be told to use it. True when the report changed.
   */
  private reportDeleted(run: AgentRun): boolean {
    const saved = run.snapshotSaved;
    if (!saved || saved.action === 'skipped' || !run.deletedSnapshots.has(saved.name)) return false;
    run.snapshotSaved = { name: saved.name, version: null, action: 'skipped', reason: DELETED_DURING_RUN };
    return true;
  }

  /** Most recent first. */
  list(): AgentRun[] {
    return [...this.runs.values()].reverse();
  }

  /** Runs holding a slot (a run paused on a question does not). */
  get activeCount(): number {
    return this.holders.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Runs paused on an unanswered question. */
  get waitingCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.isWaiting) n++;
    return n;
  }

  /** Runs paused on an unanswered question, most recent first. */
  waitingRuns(): AgentRun[] {
    return this.list().filter((r) => r.isWaiting);
  }

  /**
   * Wait until the run is done, `ms` pass, or `signal` aborts; with returnOnQuestion (the default)
   * also as soon as the run waits for the host's answer. `onProgress` is called when the step changes
   * and every few seconds while it thinks.
   */
  async wait(
    run: AgentRun,
    ms: number,
    onProgress?: (run: AgentRun) => void,
    signal?: AbortSignal,
    opts: { returnOnQuestion?: boolean } = {},
  ): Promise<void> {
    if (ms <= 0) return;
    const onQuestion = opts.returnOnQuestion ?? true;
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
        // a question for the host: the caller has to answer it, so stop waiting
        if (onQuestion && r.isWaiting) return finish();
        if (r.done) return;
        if (onProgress && (r.step !== lastStep || Date.now() - lastAt > 5_000)) {
          lastStep = r.step;
          lastAt = Date.now();
          onProgress(r);
        }
      });
      if (signal?.aborted) return finish();
      if (onQuestion && run.isWaiting) return finish();
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

  /**
   * The host's answer to a run's pending question (agent_reply). The question is closed and the run
   * is running again before this returns, so a wait right after it never reports the same question.
   */
  reply(id: string, questionId: string, answer: string, opts: { secret?: boolean; client: string | null }): { run: AgentRun; question: AgentQuestion } {
    const run = this.get(id);
    if (!run) throw new ToolError(`No agent run ${JSON.stringify(id)}. Recent runs: ${this.list().slice(0, 10).map((r) => r.id).join(', ') || 'none'}`);
    if (run.done) throw new ToolError(`Run ${run.id} already ${run.status}; it takes no answers. agent_status has its result.`);
    if (run.abort.signal.aborted) throw new ToolError(`Run ${run.id} is being cancelled; it takes no answers.`);
    const qid = questionId.trim();
    const pending = run.question;
    if (pending && pending.id === qid) {
      const question = run.closeQuestion('answered', { answer, secret: opts.secret, by: opts.client })!;
      this.log.info(
        { runId: run.id, questionId: question.id, secret: question.secret, answerChars: answer.length, client: opts.client },
        `agent run ${run.id}: question ${question.id} answered`,
      );
      return { run, question };
    }
    const earlier = run.questions.find((q) => q.id === qid);
    if (pending) {
      // never apply an answer to another question than the one it was meant for
      const now = `run ${run.id} now asks ${pending.id}: ${JSON.stringify(pending.text)}. Answer ${pending.id} with agent_reply ${inlineJson(replyArguments(run, pending, '...'))}`;
      throw new ToolError(earlier ? `Question ${qid} is closed; ${now}` : `Run ${run.id} has no question ${JSON.stringify(qid)}; ${now}`);
    }
    if (earlier?.status === 'expired') {
      throw new ToolError(`Question ${qid} expired at ${earlier.expiresAt} without an answer; the run continued without it. Use agent_wait for its result.`);
    }
    if (earlier?.status === 'answered') {
      throw new ToolError(`Question ${qid} was already answered; the run continued with that answer. Use agent_wait for its result.`);
    }
    throw new ToolError(`Run ${run.id} is not waiting for an answer (status ${run.status}). Use agent_wait for its result.`);
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
    const max = this.deps.config.agent.maxConcurrent;
    // runs resuming after a question go first: they already have a browser and a job half done
    while (this.holders.size < max && this.resumeWaiters.length > 0) this.resumeWaiters.shift()!.grant();
    let started = false;
    while (this.holders.size < max && this.queue.length > 0) {
      const run = this.queue.shift()!;
      this.holders.add(run);
      started = true;
      void this.execute(run).finally(() => this.releaseSlot(run));
    }
    if (started) {
      this.queue.forEach((r, i) => {
        r.activity = `queued (position ${i + 1})`;
        r.update();
      });
    }
  }

  /** Give the run's slot up (a no-op when it holds none) and start whoever is next. */
  private releaseSlot(run: AgentRun): void {
    if (!this.holders.delete(run)) return;
    this.pump();
  }

  /**
   * A slot for a paused run whose question closed, ahead of queued runs (never through this.queue:
   * cancel() treats queued runs as never started). False when the run is cancelled first.
   */
  private acquireSlot(run: AgentRun, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.holders.has(run)) return Promise.resolve(true);
    if (this.holders.size < this.deps.config.agent.maxConcurrent && this.resumeWaiters.length === 0) {
      this.holders.add(run);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        run,
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          this.holders.add(run);
          resolve(true);
        },
      };
      const onAbort = () => {
        const i = this.resumeWaiters.indexOf(waiter);
        if (i >= 0) this.resumeWaiters.splice(i, 1);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.resumeWaiters.push(waiter);
    });
  }

  private async execute(run: AgentRun): Promise<void> {
    const { config } = this.deps;
    const spec = KINDS[run.kind];
    const log = this.log.child({ runId: run.id, kind: run.kind });
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.activity = 'starting';
    // the agent browser's CDP log masks the host's secret answers too: a code typed into a page comes
    // back whenever the page is read
    const scrubbed = (value: unknown) => run.scrubbed(value);
    const browserLog = this.deps.log.child({}, { serializers: { params: scrubbed, result: scrubbed, error: scrubbed, url: scrubbed } });
    const browser = new Browser(config, browserLog, this.obscura, this.deps.hub, { id: `agent-${run.id}` });
    run.browserId = browser.id;
    this.registry.add(browser, { label: `${spec.label[0].toUpperCase()}${spec.label.slice(1)} agent ${run.id}`, kind: 'agent', runId: run.id });
    run.update();
    const env: RunEnv = {
      deps: this.deps,
      config,
      llm: this.llm,
      browser,
      log,
      forced: false,
      pause: () => this.releaseSlot(run),
      resume: (signal) => this.acquireSlot(run, signal),
      waitingCount: () => this.waitingCount,
    };
    log.info({ browserId: browser.id, maxSteps: run.input.maxSteps, snapshot: run.input.snapshot }, `agent run ${run.id} started`);
    try {
      // before the loop: the prompt shows the saved sign-in the browser starts with
      if (run.input.snapshot) await this.loadSnapshot(run, browser);
      await runAgentLoop(run, spec, env);
      await spec.finalize?.(run, env);
      run.finish(run.outcome ? 'completed' : 'failed', run.outcome ? null : 'the agent ended without a result');
    } catch (err) {
      if (spec.finalize && !run.abort.signal.aborted) await spec.finalize(run, env).catch(() => undefined);
      if (err instanceof LlmAbortedError || run.abort.signal.aborted) run.finish('cancelled', run.error ?? 'cancelled');
      else {
        log.error({ err: run.scrub((err as Error).message) }, `agent run ${run.id} failed`);
        run.finish('failed', (err as Error).message);
      }
    } finally {
      // a renewed sign-in dies with the browser: keep it first (only after a successful run)
      if (run.snapshot && (run.status as RunStatus) === 'completed' && run.outcome?.success && !run.abort.signal.aborted) {
        await this.refreshSnapshot(run, browser, log).catch((err) => log.warn({ err: run.scrub((err as Error).message) }, 'could not refresh the snapshot'));
      }
      await this.checkSavedSnapshot(run);
      // a cancelled run may still have a browser call running: closing the browser ends it
      await browser.dispose().catch(() => undefined);
      this.registry.close(browser.id);
    }
    log.info(
      {
        status: run.status,
        success: run.outcome?.success ?? null,
        steps: run.stepsUsed,
        questions: run.questions.length || undefined,
        waitedMs: run.pausedMs || undefined,
        durationMs: run.durationMs,
        usage: run.usage,
        compactions: run.compactions,
        // the host's secret answers (one-time codes) are masked in whatever the agent reported
        error: run.error && run.scrub(run.error),
        outcome: summarize(run.scrubbed(run.outcome), { maxString: 1_000 }),
        sources: run.sources.map((s) => s.url),
        script: run.scriptName ? { name: run.scriptName, version: run.scriptVersion, tests: run.tests.map((t) => t.ok) } : undefined,
        snapshot: run.snapshot ? { name: run.snapshot.name, version: run.snapshot.version } : undefined,
        snapshotSaved: run.snapshotSaved ?? undefined,
      },
      `agent run ${run.id} ${run.status} (${run.stepsUsed} steps, ${Math.round(run.durationMs / 1000)} s)`,
    );
    if (config.agent.transcripts) await this.writeTranscript(run).catch((err) => log.warn({ err: (err as Error).message }, 'could not write the agent transcript'));
    run.compact();
    run.update();
    run.settle();
  }

  /** Load the run's snapshot into its new browser, and have it re-applied if the engine restarts. */
  private async loadSnapshot(run: AgentRun, browser: Browser): Promise<void> {
    const name = run.input.snapshot!;
    const svc = this.deps.snapshots;
    if (!svc) throw new Error(`snapshot "${name}" cannot be loaded: snapshots are not available on this server`);
    run.activity = `loading snapshot ${name}`;
    run.update();
    let meta;
    try {
      ({ meta } = await svc.apply(browser, name));
    } catch (err) {
      const why = err instanceof SnapshotError ? ' (deleted or SNAPSHOTS_KEY changed since agent_run was called)' : '';
      throw new Error(`snapshot "${name}" could not be loaded: ${(err as Error).message}${why}`);
    }
    run.snapshot = { name, version: meta.version, description: meta.description, cookieDomains: meta.cookieDomains };
    svc.installReconnect(browser, name);
    run.update();
  }

  /**
   * Save the sign-in of a run that completed successfully back into the snapshot it started with (the
   * site may have renewed it), unless the host turned that off, the user deleted the snapshot, another
   * browser saved a newer version, the browser was reset and the snapshot could not be re-applied (after
   * a reset that re-applied it, the refresh runs as usual), or it lost or holds no sign-in cookies.
   */
  private async refreshSnapshot(run: AgentRun, browser: Browser, log: Logger): Promise<void> {
    const svc = this.deps.snapshots;
    const snap = run.snapshot!;
    if (!svc || run.input.updateSnapshot === false) return;
    const skip = (reason: string) => {
      log.info({ snapshot: snap.name, reason }, `snapshot ${snap.name} not refreshed`);
      // a sign-in the run saved itself stays reported
      if (!run.snapshotSaved || run.snapshotSaved.action === 'skipped') run.snapshotSaved = { name: snap.name, version: null, action: 'skipped', reason };
    };
    if (run.deletedSnapshots.has(snap.name)) return skip(DELETED_DURING_RUN);
    const loaded = browser.loadedSnapshots.get(snap.name);
    if (!loaded || !browser.connected) return skip('the browser was reset during the run');
    try {
      const out = await browser.mutex.run(() => svc.update(browser, snap.name, { mode: 'refresh', by: { runId: run.id }, expectVersion: loaded.version }));
      // deleted while it was saved: the files are gone, and so is the report
      if (run.deletedSnapshots.has(snap.name)) return skip(DELETED_DURING_RUN);
      run.snapshotSaved = { name: snap.name, version: out.meta.version, action: 'refreshed' };
    } catch (err) {
      if (err instanceof SnapshotConflictError) return skip(`v${err.current.version} was saved meanwhile`);
      if (err instanceof SnapshotNotFoundError) return skip(DELETED_DURING_RUN);
      if (err instanceof SnapshotEmptyError) return skip(`the agent's browser had no sign-in cookies for ${domainsText(snap.cookieDomains)} at the end`);
      // a page may have signed the browser out: never overwrite a working sign-in with that
      if (err instanceof SnapshotSignedOutError) return skip(`the agent's browser lost ${err.lost} saved sign-in cookie${err.lost === 1 ? '' : 's'} (signed out?)`);
      return skip(run.scrub((err as Error).message));
    }
  }

  /**
   * A snapshot the run reports as saved must still exist when it ends: a delete can land while
   * save_sign_in writes it (before the run knows the name), so look at the store once more.
   */
  private async checkSavedSnapshot(run: AgentRun): Promise<void> {
    const saved = run.snapshotSaved;
    const svc = this.deps.snapshots;
    if (!svc || !saved || saved.action === 'skipped') return;
    if (!run.deletedSnapshots.has(saved.name) && !(await svc.store.exists(saved.name).catch(() => true))) run.deletedSnapshots.add(saved.name);
    if (this.reportDeleted(run)) run.update();
  }

  private async writeTranscript(run: AgentRun): Promise<void> {
    await mkdir(this.transcriptDir, { recursive: true });
    const stamp = run.createdAt.replace(/[:.]/g, '-');
    const file = path.join(this.transcriptDir, `${stamp}_${run.kind}_${run.id}.json`);
    // the transcript is a plain file: the host's secret answers are masked everywhere in it
    const body = run.scrubbed({
      summary: run.summary(),
      input: run.input,
      outcome: run.outcome,
      error: run.error,
      notes: run.notes,
      sources: run.sources,
      visited: [...run.visited.entries()].map(([url, v]) => ({ url, ...v })),
      script: run.scriptName ? { name: run.scriptName, version: run.scriptVersion, tests: run.tests } : null,
      questions: run.questionLog(),
      waitedMs: run.pausedMs,
      steps: run.steps,
      // tool-call arguments as logged (values typed into password-like fields stay masked), and tool
      // results as shown (a secret answer masked)
      messages: run.messages.map((m) => {
        if (m.role === 'tool' && m.tool_call_id && run.redactedResults.has(m.tool_call_id)) return { ...m, content: run.redactedResults.get(m.tool_call_id)! };
        return m.tool_calls?.some((c) => run.redactedCalls.has(c.id))
          ? { ...m, tool_calls: m.tool_calls.map((c) => (run.redactedCalls.has(c.id) ? { ...c, function: { ...c.function, arguments: run.redactedCalls.get(c.id)! } } : c)) }
          : m;
      }),
    });
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
