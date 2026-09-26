import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { ToolError } from '../browser/errors.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { MAX_WAITING, SCRIPT_MAX_RUNS } from '../util/limits.ts';

export interface ObscuraStatus {
  mode: 'managed' | 'external';
  running: boolean;
  ready: boolean;
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  cdpHttpUrl: string;
  args: string[];
}

// `2026-09-17T06:26:52.765506Z  INFO obscura_cdp::server: message`
const TRACING_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s?(.*)$/;
const ANSI = /\x1b\[[0-9;]*m/g;

// OBSCURA_* variables the user might set that must never be forwarded into the browser process's
// environment: proxy credentials travel via the --proxy argument, never the environment.
const OBSCURA_ENV_DENYLIST = new Set(['OBSCURA_PROXY']);
// After a (re)start, wait this long with the child still alive before trusting it enough to reset
// the crash backoff: a child that flaps (e.g. loses an EADDRINUSE race) must not keep resetting it.
const STABLE_AFTER_MS = 5_000;

/** Engine log lines longer than this are cut before they are logged (a page can make Obscura log huge URLs). */
const MAX_ENGINE_LINE = 8_000;

/** Hide the password in URLs such as a proxy "http://user:pass@host:port" before logging or reporting them. */
export function maskCredentials(value: string): string {
  // bounded quantifiers keep this linear on long input (an unbounded scheme run backtracks quadratically)
  // '@' may appear inside the user name or password: the last '@' before the host ends the credentials
  return value.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s:]{1,4096}):([^/\s]{1,4096})@/gi, '$1$2:***@');
}

function capLine(text: string): string {
  return text.length > MAX_ENGINE_LINE ? `${text.slice(0, MAX_ENGINE_LINE)}…(+${text.length - MAX_ENGINE_LINE} chars)` : text;
}

/**
 * Owns the Obscura browser engine. In "managed" mode it spawns
 * `obscura serve` bound to container loopback, forwards every line it prints
 * into our structured logs, and restarts it with backoff if it crashes.
 * In "external" mode (OBSCURA_CDP_URL set) it only health-checks an Obscura
 * instance that someone else runs.
 */
export class ObscuraProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  /** Set when spawn itself fails (e.g. ENOENT); makes start()/waitReady reject at once. */
  private spawnError: Error | null = null;
  private readonly status: ObscuraStatus;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly engineLog: Logger;

  constructor(config: Config, log: Logger) {
    super();
    this.config = config;
    this.log = log.child({ component: 'obscura' });
    this.engineLog = log.child({ component: 'obscura-engine' });
    const external = Boolean(config.obscura.cdpUrl);
    this.status = {
      mode: external ? 'external' : 'managed',
      running: false,
      ready: false,
      pid: null,
      version: null,
      startedAt: null,
      restarts: 0,
      lastExit: null,
      cdpHttpUrl: external ? httpUrlFromWs(config.obscura.cdpUrl!) : `http://127.0.0.1:${config.obscura.cdpPort}`,
      args: [],
    };
  }

  /** WebSocket URL of Obscura's browser endpoint. */
  get cdpWebSocketUrl(): string {
    return this.config.obscura.cdpUrl ?? `ws://127.0.0.1:${this.config.obscura.cdpPort}/devtools/browser`;
  }

  getStatus(): ObscuraStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (this.status.mode === 'external') {
      this.log.info({ cdpUrl: this.config.obscura.cdpUrl }, 'using external Obscura instance (OBSCURA_CDP_URL set)');
      await this.waitReady(30_000);
      return;
    }
    this.status.version = await this.readVersion();
    // Refuse to spawn a managed Obscura on top of something already answering on the CDP port
    // (a foreign or orphaned instance). Otherwise our child would die with EADDRINUSE while the
    // health probe keeps passing against the other process, hiding the failure.
    if (await this.probe()) {
      throw new Error(
        `Something is already listening on the Obscura CDP endpoint (${this.status.cdpHttpUrl}). ` +
          'Refusing to start a managed Obscura on top of it. Free the port, set OBSCURA_CDP_PORT to a free port, ' +
          'or set OBSCURA_CDP_URL to drive that instance in external mode.',
      );
    }
    this.spawnChild();
    await this.waitReady(30_000);
  }

  buildArgs(): string[] {
    const o = this.config.obscura;
    // one CDP connection per browser: the main one, each running sub-agent and its script test, sub-agents
    // paused on a question (they keep their browser), script runs, and a few spare
    const connections = Math.max(16, 1 + 2 * this.config.agent.maxConcurrent + MAX_WAITING + SCRIPT_MAX_RUNS + 4);
    const args = ['serve', '--host', '127.0.0.1', '--port', String(o.cdpPort), '--max-connections', String(connections)];
    if (o.stealth) args.push('--stealth');
    if (o.proxy) args.push('--proxy', o.proxy);
    if (o.userAgent) args.push('--user-agent', o.userAgent);
    if (o.allowPrivateNetwork) args.push('--allow-private-network');
    if (o.storageDir) args.push('--storage-dir', o.storageDir);
    args.push(...o.extraArgs);
    return args;
  }

  /**
   * The environment for the spawned browser. We do NOT inherit the whole supervisor environment:
   * secrets that reach Node (AUTH_TOKEN, proxy credentials, cloud tokens, …) must never end up in
   * the browser's environment, where a page that reaches file:///proc/self/environ could read them.
   * Only an allow-list of base variables and the OBSCURA_* tuning knobs Obscura reads are forwarded;
   * proxy credentials are passed via the --proxy argument instead.
   */
  buildEnv(): NodeJS.ProcessEnv {
    const o = this.config.obscura;
    const env: NodeJS.ProcessEnv = {};
    const passthrough = [
      'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'USER', 'LOGNAME', 'SHELL',
      // Windows base variables so the binary can find system libraries when run there
      'SystemRoot', 'PATHEXT', 'WINDIR', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    ];
    for (const key of passthrough) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LC_')) env[key] = process.env[key];
      else if (key.startsWith('OBSCURA_') && !OBSCURA_ENV_DENYLIST.has(key)) env[key] = process.env[key];
    }
    // Values the supervisor controls always win over anything inherited above.
    env.NO_COLOR = '1';
    env.RUST_LOG = o.logFilter;
    env.OBSCURA_NAV_TIMEOUT_MS = String(o.navTimeoutMs);
    env.OBSCURA_CDP_COMMAND_TIMEOUT_MS = String(o.jsWatchdogMs);
    if (o.allowPrivateNetwork) env.OBSCURA_ALLOW_PRIVATE_NETWORK = '1';
    else delete env.OBSCURA_ALLOW_PRIVATE_NETWORK;
    return env;
  }

  private readVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.config.obscura.bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? ' (binary not found — run `npm run obscura:download` for local development, or set OBSCURA_BIN)'
              : '';
          this.log.error({ bin: this.config.obscura.bin, err: err.message }, `could not run Obscura${hint}`);
          resolve(null);
          return;
        }
        const version = stdout.trim().replace(/^obscura\s+/i, '');
        this.log.info({ bin: this.config.obscura.bin, version }, 'found Obscura binary');
        resolve(version);
      });
    });
  }

  private spawnChild(): void {
    const args = this.buildArgs();
    this.status.args = args.map(maskCredentials);
    this.spawnError = null;
    this.log.info({ bin: this.config.obscura.bin, args: this.status.args, stealth: this.config.obscura.stealth }, 'starting Obscura');

    const child = spawn(this.config.obscura.bin, args, { env: this.buildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.status.running = true;
    this.status.ready = false;
    this.status.pid = child.pid ?? null;
    this.status.startedAt = new Date().toISOString();

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.log.error({ err: err.message, code }, 'failed to start Obscura');
      // A spawn failure (e.g. the binary does not exist) emits 'error' with no pid and no later
      // 'exit'. Record it so start()/waitReady reject immediately instead of polling for 30 s.
      if (this.child === child && child.pid === undefined) {
        this.child = null;
        this.status.running = false;
        this.status.pid = null;
        const hint =
          code === 'ENOENT'
            ? ` (binary not found at "${this.config.obscura.bin}" — run \`npm run obscura:download\` for local development, or set OBSCURA_BIN)`
            : '';
        this.spawnError = new Error(`Obscura failed to start: ${err.message}${hint}`);
      }
    });

    createInterface({ input: child.stdout! }).on('line', (line) => {
      const clean = line.replace(ANSI, '').trimEnd();
      if (clean.trim()) this.engineLog.debug({ stream: 'stdout' }, capLine(maskCredentials(clean)));
    });

    // One record per engine message: continuation lines (e.g. a JS stack trace) are appended to the
    // message they belong to, which is written once the next message starts or output pauses.
    let pending: { level: 'debug' | 'info' | 'warn' | 'error'; fields: Record<string, unknown>; lines: string[] } | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (!pending) return;
      const { level, fields, lines } = pending;
      pending = null;
      this.engineLog[level](lines.length > 1 ? { ...fields, lines: lines.length } : fields, capLine(maskCredentials(lines.join('\n'))));
    };
    const stderr = createInterface({ input: child.stderr! });
    stderr.on('line', (line) => {
      const clean = line.replace(ANSI, '').trimEnd();
      if (!clean.trim()) return;
      const m = TRACING_LINE.exec(clean);
      if (m) {
        flush();
        const [, time, lvl, target, message] = m;
        pending = { level: mapLevel(lvl!), fields: { stream: 'stderr', target, engineTime: time }, lines: [message!] };
      } else if (pending && pending.lines.length < 200) {
        pending.lines.push(clean);
      } else {
        flush();
        pending = { level: 'info', fields: { stream: 'stderr' }, lines: [clean] };
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 50);
    });
    stderr.on('close', flush);

    child.on('exit', (code, signal) => {
      this.status.running = false;
      this.status.ready = false;
      this.status.pid = null;
      this.status.lastExit = { code, signal, at: new Date().toISOString() };
      this.child = null;
      if (this.stopping) {
        this.log.info({ code, signal }, 'Obscura stopped');
        return;
      }
      this.log.error({ code, signal }, 'Obscura exited unexpectedly');
      this.emit('exit', { code, signal });
      if (this.config.obscura.restartOnCrash) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping) return;
    this.consecutiveFailures++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.consecutiveFailures - 1, 6));
    this.log.warn({ delayMs: delay, attempt: this.consecutiveFailures }, 'restarting Obscura');
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.status.restarts++;
      this.spawnChild();
      try {
        await this.waitReady(30_000);
        this.emit('restarted');
        // Reset the crash backoff only once the restarted child has proven stable for a short
        // while. A child that flaps (e.g. keeps losing an EADDRINUSE race) must not keep resetting
        // the backoff to its 500 ms floor forever.
        const stable = this.child;
        setTimeout(() => {
          if (this.child === stable && stable?.exitCode === null && stable?.signalCode === null) this.consecutiveFailures = 0;
        }, STABLE_AFTER_MS).unref();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'Obscura did not become ready after restart');
      }
    }, delay);
  }

  /** True while our spawned child has already exited (managed mode). */
  private childDead(): boolean {
    return !this.child || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Poll `/json/version` (served on a dedicated thread, so it answers even while V8 is busy). */
  async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    const pause = () => new Promise((r) => setTimeout(r, 150));
    while (Date.now() < deadline) {
      if (this.spawnError) throw this.spawnError;
      if (this.status.mode === 'managed' && this.childDead()) {
        // A restart is scheduled during the ~500 ms crash window: wait for the new child to come up
        // rather than throwing a bare "not running" that the tool layer treats as unexpected.
        if (this.restartTimer) {
          lastError = 'Obscura is restarting';
          await pause();
          continue;
        }
        throw new ToolError('The browser engine is not running (it may be restarting after a crash); retry the call in a moment. Open tabs and cookies were lost.');
      }
      try {
        const res = await fetch(`${this.status.cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          // In managed mode, only trust the probe when OUR child is the live process answering it,
          // never a foreign/orphaned Obscura that grabbed the port after our child died.
          if (this.status.mode === 'managed' && this.childDead()) {
            lastError = 'CDP port answered but the managed Obscura child is not alive';
            await pause();
            continue;
          }
          const info = (await res.json()) as Record<string, string>;
          if (!this.status.ready) this.log.info({ browser: info.Browser, protocol: info['Protocol-Version'] }, 'Obscura is ready');
          this.status.ready = true;
          if (this.status.mode === 'external') this.status.running = true;
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = (err as Error).message;
      }
      await pause();
    }
    if (this.status.mode === 'managed' && (this.childDead() || this.restartTimer)) {
      throw new ToolError(`The browser engine did not become ready within ${timeoutMs} ms (${lastError}); retry the call in a moment.`);
    }
    throw new Error(`Obscura did not become ready within ${timeoutMs} ms (${lastError})`);
  }

  /** Cheap liveness probe used by /healthz. */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.status.cdpHttpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Synchronously SIGKILL the child. Called from process 'exit' and fatal-exit handlers so a crashing
   * Node process never leaves an orphaned Obscura behind (async stop() cannot run during 'exit').
   */
  killSync(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // best effort
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.log.warn('Obscura did not exit after SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

function mapLevel(level: string): 'debug' | 'info' | 'warn' | 'error' {
  switch (level) {
    case 'ERROR':
      return 'error';
    case 'WARN':
      return 'warn';
    case 'INFO':
      return 'info';
    default:
      return 'debug';
  }
}

function httpUrlFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${u.protocol}//${u.host}`;
}
