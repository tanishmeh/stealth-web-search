import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';

/**
 * All runtime configuration comes from environment variables so the same image
 * works under `docker run -e`, docker compose `.env`, and a local `npm run dev`.
 * Every variable is documented in `.env.example` and docs/CONFIGURATION.md.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean (true/false), got "${v}"` });
      return z.NEVER;
    });

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected an integer between ${min} and ${max}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const str = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim()));

const optStr = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const list = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const level = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const s = (v ?? '').trim().toLowerCase() || fallback;
      if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(s)) {
        ctx.addIssue({ code: 'custom', message: `invalid log level "${v}"` });
        return z.NEVER;
      }
      return s as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
    });

const EnvSchema = z.object({
  // --- HTTP server (MCP endpoint + dashboard) ---
  HOST: str('127.0.0.1'),
  PORT: int(8931, 1, 65535),
  PUBLIC_URL: optStr(),
  AUTH_TOKEN: optStr(),
  ALLOWED_HOSTS: list([]),
  DASHBOARD_ENABLED: bool(true),
  SESSION_IDLE_TIMEOUT_MS: int(30 * 60_000, 0),
  // Upper bound on concurrent MCP sessions; further initialize requests are refused (503).
  MAX_SESSIONS: int(100, 1),

  // --- Obscura ---
  OBSCURA_BIN: optStr(),
  OBSCURA_CDP_URL: optStr(),
  // In managed mode, when this is left unset a random free ephemeral port is chosen at startup
  // (rather than a fixed, predictable 9222 that any local process could reach). The value below is
  // only used as a fallback default; whether the user set it explicitly is tracked separately.
  OBSCURA_CDP_PORT: int(9222, 1, 65535),
  OBSCURA_STEALTH: bool(true),
  OBSCURA_PROXY: optStr(),
  OBSCURA_USER_AGENT: optStr(),
  OBSCURA_STORAGE_DIR: optStr(),
  OBSCURA_EXTRA_ARGS: optStr(),
  OBSCURA_LOG_FILTER: str('warn,obscura=info,obscura_cdp=info,obscura_browser=warn'),
  OBSCURA_NAV_TIMEOUT_MS: int(30_000, 1_000),
  OBSCURA_JS_WATCHDOG_MS: int(30_000, 0),
  OBSCURA_RESTART_ON_CRASH: bool(true),
  ALLOW_PRIVATE_NETWORK: bool(false),

  // --- Browser behaviour ---
  VIEWPORT_WIDTH: int(1280, 100, 7680),
  VIEWPORT_HEIGHT: int(720, 100, 4320),
  ALLOWED_URL_SCHEMES: list(['http', 'https', 'about', 'data']),
  TOOL_TIMEOUT_MS: int(120_000, 1_000),
  CDP_COMMAND_TIMEOUT_MS: int(45_000, 1_000),
  TOOLSETS: list(['all']),

  // --- Live view ---
  LIVE_VIEW_ENABLED: bool(true),
  LIVE_VIEW_QUALITY: int(60, 10, 100),
  LIVE_VIEW_MAX_WIDTH: int(1280, 200, 3840),
  LIVE_VIEW_MAX_HEIGHT: int(720, 200, 2160),

  // --- Logging ---
  LOG_LEVEL: level('info'),
  LOG_FILE_LEVEL: level('debug'),
  LOG_FORMAT: optStr(),
  LOG_DIR: optStr(),
  LOG_FILE_MAX_SIZE: str('20m'),
  LOG_FILE_MAX_FILES: int(14, 1, 1000),
  LOG_MAX_STRING_LENGTH: int(2000, 80),
  LOG_REDACT_SECRETS: bool(true),
  LOG_CDP_EVENTS: bool(true),
});

export type Config = ReturnType<typeof loadConfig>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;

  const logFormat = e.LOG_FORMAT ?? (process.stdout.isTTY ? 'pretty' : 'json');
  if (logFormat !== 'pretty' && logFormat !== 'json') {
    throw new ConfigError(`Invalid configuration:\n  - LOG_FORMAT: expected "json" or "pretty", got "${logFormat}"`);
  }

  const allowedHosts = Array.from(
    new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal', ...e.ALLOWED_HOSTS]),
  );

  // Whether the user pinned the CDP port explicitly (vs. falling back to the schema default). In
  // managed mode an unpinned port is replaced by a random free port at startup so the CDP endpoint
  // is not on a predictable, reachable-by-default port.
  const cdpPortExplicit = typeof env.OBSCURA_CDP_PORT === 'string' && env.OBSCURA_CDP_PORT.trim() !== '';

  const schemes = e.ALLOWED_URL_SCHEMES.map((s) => s.toLowerCase().replace(/:$/, ''));
  const forbidden = schemes.filter((s) => ['file', 'javascript', 'chrome', 'view-source'].includes(s));
  if (forbidden.length) {
    throw new ConfigError(`Invalid configuration:\n  - ALLOWED_URL_SCHEMES: "${forbidden.join(', ')}" can never be allowed`);
  }

  return {
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL ?? `http://127.0.0.1:${e.PORT}`,
    authToken: e.AUTH_TOKEN,
    allowedHosts,
    dashboardEnabled: e.DASHBOARD_ENABLED,
    sessionIdleTimeoutMs: e.SESSION_IDLE_TIMEOUT_MS,
    maxSessions: e.MAX_SESSIONS,

    obscura: {
      bin: e.OBSCURA_BIN ?? resolveDefaultObscuraBin(),
      cdpUrl: e.OBSCURA_CDP_URL,
      cdpPort: e.OBSCURA_CDP_PORT,
      cdpPortExplicit,
      stealth: e.OBSCURA_STEALTH,
      proxy: e.OBSCURA_PROXY,
      userAgent: e.OBSCURA_USER_AGENT,
      storageDir: e.OBSCURA_STORAGE_DIR,
      extraArgs: e.OBSCURA_EXTRA_ARGS ? splitArgs(e.OBSCURA_EXTRA_ARGS) : [],
      logFilter: e.OBSCURA_LOG_FILTER,
      navTimeoutMs: e.OBSCURA_NAV_TIMEOUT_MS,
      jsWatchdogMs: e.OBSCURA_JS_WATCHDOG_MS,
      restartOnCrash: e.OBSCURA_RESTART_ON_CRASH,
      allowPrivateNetwork: e.ALLOW_PRIVATE_NETWORK,
    },

    browser: {
      viewport: { width: e.VIEWPORT_WIDTH, height: e.VIEWPORT_HEIGHT },
      allowedUrlSchemes: schemes,
      toolTimeoutMs: e.TOOL_TIMEOUT_MS,
      cdpCommandTimeoutMs: e.CDP_COMMAND_TIMEOUT_MS,
      toolsets: e.TOOLSETS.map((t) => t.toLowerCase()),
    },

    liveView: {
      enabled: e.LIVE_VIEW_ENABLED,
      quality: e.LIVE_VIEW_QUALITY,
      maxWidth: e.LIVE_VIEW_MAX_WIDTH,
      maxHeight: e.LIVE_VIEW_MAX_HEIGHT,
    },

    log: {
      level: e.LOG_LEVEL,
      fileLevel: e.LOG_FILE_LEVEL,
      format: logFormat as 'pretty' | 'json',
      dir: e.LOG_DIR ?? path.join(PROJECT_ROOT, 'logs'),
      fileMaxSize: e.LOG_FILE_MAX_SIZE,
      fileMaxFiles: e.LOG_FILE_MAX_FILES,
      maxStringLength: e.LOG_MAX_STRING_LENGTH,
      redactSecrets: e.LOG_REDACT_SECRETS,
      cdpEvents: e.LOG_CDP_EVENTS,
    },
  };
}

/** Local development: prefer the binary fetched by `npm run obscura:download`. */
function resolveDefaultObscuraBin(): string {
  const local = path.join(PROJECT_ROOT, '.obscura', process.platform === 'win32' ? 'obscura.exe' : 'obscura');
  if (existsSync(local)) return local;
  return 'obscura';
}

/** Split a shell-like argument string, honouring simple single/double quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}
