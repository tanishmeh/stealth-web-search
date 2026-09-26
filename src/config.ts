import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { type FileModel, loadModelsFile } from './models-config.ts';

/**
 * All runtime configuration comes from environment variables so the same image
 * works under `docker run -e`, docker compose `.env`, and a local `npm run dev`.
 * Every variable is documented in `.env.example` and docs/CONFIGURATION.md. The sub-agents'
 * model can also come from a JSON file (config/models.json, see models-config.ts and docs/MODELS.md).
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

/** Longest delay setTimeout supports; longer *_MS values would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** A number, or null when set to "none" (the field is then left out of requests). */
const numOrNone = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      if (['none', 'off', 'unset'].includes(v.trim().toLowerCase())) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `expected a number between ${min} and ${max} (or "none"), got "${v}"` });
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
  SESSION_IDLE_TIMEOUT_MS: int(30 * 60_000, 0, MAX_TIMER_MS),
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
  OBSCURA_NAV_TIMEOUT_MS: int(30_000, 1_000, MAX_TIMER_MS),
  OBSCURA_JS_WATCHDOG_MS: int(30_000, 0, MAX_TIMER_MS),
  OBSCURA_RESTART_ON_CRASH: bool(true),
  // Sub-agent and script browsers run on a second engine process, so a page that crashes the engine
  // there never resets the main browser (always on with OBSCURA_STORAGE_DIR).
  OBSCURA_SEPARATE_ENGINE: bool(true),
  ALLOW_PRIVATE_NETWORK: bool(false),

  // --- Browser behaviour ---
  VIEWPORT_WIDTH: int(1280, 100, 7680),
  VIEWPORT_HEIGHT: int(720, 100, 4320),
  ALLOWED_URL_SCHEMES: list(['http', 'https', 'about', 'data']),
  TOOL_TIMEOUT_MS: int(120_000, 1_000, MAX_TIMER_MS),
  CDP_COMMAND_TIMEOUT_MS: int(45_000, 1_000, MAX_TIMER_MS),
  TOOLSETS: list(['all']),

  // --- Live view ---
  LIVE_VIEW_ENABLED: bool(true),
  LIVE_VIEW_QUALITY: int(60, 10, 100),
  LIVE_VIEW_MAX_WIDTH: int(1280, 200, 3840),
  LIVE_VIEW_MAX_HEIGHT: int(720, 200, 2160),

  // --- Sub-agents (OpenAI-compatible chat completions endpoint) ---
  // A models file (config/models.json by default) or AGENT_LLM_URL enables the agent_* tools.
  AGENT_MODELS_FILE: optStr(),
  AGENT_LLM_URL: optStr(),
  AGENT_LLM_API_KEY: optStr(),
  AGENT_LLM_MODEL: optStr(),
  // "none" leaves the field out (e.g. OpenAI reasoning models only accept the defaults)
  AGENT_LLM_TEMPERATURE: numOrNone(0.4, 0, 2),
  AGENT_LLM_TOP_P: numOrNone(0.95, 0, 1),
  // Name of the output-token limit field: max_tokens (vLLM, LM Studio, Ollama…) or max_completion_tokens (OpenAI)
  AGENT_LLM_MAX_TOKENS_FIELD: str('max_tokens'),
  // Sent as reasoning_effort; "" or "none" leaves it out.
  AGENT_LLM_REASONING_EFFORT: str('medium'),
  // true/false sends chat_template_kwargs.enable_thinking (Qwen-style templates); unset leaves the model default.
  AGENT_LLM_THINKING: optStr(),
  AGENT_LLM_STREAMING: bool(true),
  // JSON object merged into every request body (e.g. {"top_k": 20}).
  AGENT_LLM_EXTRA_BODY: optStr(),
  // Longest silence from the model endpoint before a request fails.
  AGENT_LLM_TIMEOUT_MS: int(300_000, 5_000, MAX_TIMER_MS),
  AGENT_CONTEXT_TOKENS: int(65_536, 8_192),
  AGENT_MAX_OUTPUT_TOKENS: int(8_192, 256),
  AGENT_MAX_STEPS: int(40, 1, 500),
  AGENT_MAX_RUNTIME_MS: int(15 * 60_000, 10_000, MAX_TIMER_MS),
  AGENT_MAX_CONCURRENT: int(2, 1, 16),
  // How long agent_* tools wait for a run before returning "still running" (the run keeps going).
  AGENT_WAIT_SECONDS: int(170, 0, 3_600),
  AGENT_MAX_RESULT_CHARS: int(12_000, 1_000),
  AGENT_SEARCH_ENGINE: str('duckduckgo'),
  AGENT_TRANSCRIPTS: bool(true),
  // How long a run paused on a question (ask_host) waits for agent_reply before it continues without an answer.
  AGENT_REPLY_TIMEOUT_MS: int(30 * 60_000, 10_000, MAX_TIMER_MS),
  // Questions one run may ask the host (0: sub-agents never ask).
  AGENT_MAX_QUESTIONS: int(5, 0, 50),
  // Sub-agents may save a sign-in as a snapshot (save_sign_in; only when the snapshots group is enabled).
  AGENT_SNAPSHOT_SAVE: bool(true),

  // --- Automation scripts ---
  SCRIPTS_DIR: optStr(),
  SCRIPT_TIMEOUT_MS: int(5 * 60_000, 1_000, MAX_TIMER_MS),
  SCRIPT_MEMORY_MB: int(64, 8, 1_024),

  // --- Snapshots (saved sign-ins: cookies and site storage) ---
  SNAPSHOTS_DIR: optStr(),
  // Encrypts the saved states (AES-256-GCM); any string. Never logged.
  SNAPSHOTS_KEY: optStr(),

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

/** Where the server looks for the models file when AGENT_MODELS_FILE is not set. */
export const DEFAULT_MODELS_FILE = path.join(PROJECT_ROOT, 'config', 'models.json');

/** Host names always allowed (loopback and Docker's name for the host), before ALLOWED_HOSTS. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'];

/**
 * `defaultModelsFile`: the models file to use when it exists and AGENT_MODELS_FILE is not set. The
 * server passes DEFAULT_MODELS_FILE; without it only AGENT_MODELS_FILE is read (as in tests).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, { defaultModelsFile }: { defaultModelsFile?: string } = {}) {
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

  const allowedHosts = Array.from(new Set([...DEFAULT_ALLOWED_HOSTS, ...e.ALLOWED_HOSTS]));

  // Whether the user pinned the CDP port explicitly (vs. falling back to the schema default). In
  // managed mode an unpinned port is replaced by a random free port at startup so the CDP endpoint
  // is not on a predictable, reachable-by-default port.
  const cdpPortExplicit = typeof env.OBSCURA_CDP_PORT === 'string' && env.OBSCURA_CDP_PORT.trim() !== '';

  const schemes = e.ALLOWED_URL_SCHEMES.map((s) => s.toLowerCase().replace(/:$/, ''));
  const forbidden = schemes.filter((s) => ['file', 'javascript', 'chrome', 'view-source'].includes(s));
  if (forbidden.length) {
    throw new ConfigError(`Invalid configuration:\n  - ALLOWED_URL_SCHEMES: "${forbidden.join(', ')}" can never be allowed`);
  }

  const invalid = (name: string, message: string) => new ConfigError(`Invalid configuration:\n  - ${name}: ${message}`);
  /** Set in the environment (not just the schema default). */
  const explicit = (name: string) => typeof env[name] === 'string' && env[name]!.trim() !== '';

  let fileModel: FileModel | null = null;
  const modelsFile = resolveModelsFile(e.AGENT_MODELS_FILE, defaultModelsFile);
  if (modelsFile) {
    try {
      fileModel = loadModelsFile(modelsFile, env, e.AGENT_LLM_MODEL);
    } catch (err) {
      throw invalid('AGENT_MODELS_FILE', (err as Error).message);
    }
  }
  // Variables set in the environment override the file, field by field.
  const overrides = fileModel
    ? ['AGENT_LLM_URL', 'AGENT_LLM_API_KEY', 'AGENT_LLM_TEMPERATURE', 'AGENT_LLM_TOP_P', 'AGENT_LLM_REASONING_EFFORT', 'AGENT_LLM_STREAMING'].filter(explicit)
    : [];
  const fromFile = <T>(name: string, fileValue: T | undefined, envValue: T): T =>
    fileModel && !explicit(name) && fileValue !== undefined ? fileValue : envValue;

  let agentEndpoint: string | undefined;
  const agentUrl = explicit('AGENT_LLM_URL') ? e.AGENT_LLM_URL : fileModel?.url;
  if (agentUrl) {
    try {
      agentEndpoint = chatCompletionsUrl(agentUrl);
    } catch (err) {
      throw explicit('AGENT_LLM_URL') ? invalid('AGENT_LLM_URL', (err as Error).message) : invalid('AGENT_MODELS_FILE', `${fileModel!.file}: url: ${(err as Error).message}`);
    }
  }
  let agentThinking: boolean | undefined;
  if (e.AGENT_LLM_THINKING !== undefined) {
    const s = e.AGENT_LLM_THINKING.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) agentThinking = true;
    else if (['0', 'false', 'no', 'off'].includes(s)) agentThinking = false;
    else throw invalid('AGENT_LLM_THINKING', `expected true or false, got "${e.AGENT_LLM_THINKING}"`);
  }
  let agentExtraBody: Record<string, unknown> = {};
  if (e.AGENT_LLM_EXTRA_BODY) {
    try {
      const parsedBody = JSON.parse(e.AGENT_LLM_EXTRA_BODY);
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) throw new Error('not an object');
      agentExtraBody = parsedBody;
    } catch {
      throw invalid('AGENT_LLM_EXTRA_BODY', 'expected a JSON object, e.g. {"top_k": 20}');
    }
  }
  const modelsFileOff = e.AGENT_MODELS_FILE !== undefined && ['none', 'off'].includes(e.AGENT_MODELS_FILE.toLowerCase());
  const disabledReason = agentEndpoint
    ? null
    : modelsFileOff
      ? 'AGENT_MODELS_FILE=none turns the models file off and AGENT_LLM_URL is not set'
      : `no ${defaultModelsFile ?? 'models file (AGENT_MODELS_FILE)'} and AGENT_LLM_URL is not set`;
  const envEffort = e.AGENT_LLM_REASONING_EFFORT.toLowerCase();
  const envEffortValue = envEffort === '' || envEffort === 'none' || envEffort === 'off' ? null : envEffort;
  const reasoningEffort = fromFile('AGENT_LLM_REASONING_EFFORT', fileModel?.reasoningEffort, envEffortValue);
  const maxTokensField = e.AGENT_LLM_MAX_TOKENS_FIELD;
  if (maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens') {
    throw invalid('AGENT_LLM_MAX_TOKENS_FIELD', `expected "max_tokens" or "max_completion_tokens", got "${maxTokensField}"`);
  }
  const searchEngine = e.AGENT_SEARCH_ENGINE.toLowerCase();
  if (!['duckduckgo', 'bing'].includes(searchEngine)) {
    throw invalid('AGENT_SEARCH_ENGINE', `expected "duckduckgo" or "bing", got "${e.AGENT_SEARCH_ENGINE}"`);
  }
  // Saved sign-ins hold live session cookies: never next to the logs (a bind mount users share) or the scripts
  const logDir = path.resolve(e.LOG_DIR ?? path.join(PROJECT_ROOT, 'logs'));
  const scriptsDir = path.resolve(e.SCRIPTS_DIR ?? path.join(PROJECT_ROOT, 'data', 'scripts'));
  const snapshotsDir = path.resolve(e.SNAPSHOTS_DIR ?? path.join(PROJECT_ROOT, 'data', 'snapshots'));
  if (snapshotsDir === logDir || snapshotsDir.startsWith(`${logDir}${path.sep}`)) {
    throw invalid('SNAPSHOTS_DIR', `must not be inside LOG_DIR (${logDir}): log folders are shared and downloadable, snapshots hold sign-in cookies`);
  }
  if (snapshotsDir === scriptsDir) throw invalid('SNAPSHOTS_DIR', `must not be the same folder as SCRIPTS_DIR (${scriptsDir})`);

  // The agent's budget is AGENT_CONTEXT_TOKENS / AGENT_MAX_OUTPUT_TOKENS, capped by the model's limits from the file.
  const agentWarnings = [...(fileModel?.warnings ?? [])];
  let contextTokens = e.AGENT_CONTEXT_TOKENS;
  let maxOutputTokens = e.AGENT_MAX_OUTPUT_TOKENS;
  if (fileModel?.contextWindow !== undefined && fileModel.contextWindow < contextTokens) {
    if (fileModel.contextWindow < 8_192) {
      throw invalid('AGENT_MODELS_FILE', `${fileModel.file}: contextWindow ${fileModel.contextWindow} of "${fileModel.id}" is too small for sub-agents (at least 8192)`);
    }
    if (explicit('AGENT_CONTEXT_TOKENS')) agentWarnings.push(`AGENT_CONTEXT_TOKENS ${contextTokens} is more than the model's contextWindow; using ${fileModel.contextWindow}`);
    contextTokens = fileModel.contextWindow;
  }
  if (fileModel?.maxOutputTokens !== undefined && fileModel.maxOutputTokens < maxOutputTokens) maxOutputTokens = fileModel.maxOutputTokens;
  if (maxOutputTokens >= contextTokens / 2) {
    if (explicit('AGENT_MAX_OUTPUT_TOKENS') || contextTokens === e.AGENT_CONTEXT_TOKENS) {
      throw invalid('AGENT_MAX_OUTPUT_TOKENS', `must be less than half of the context budget (${contextTokens} tokens)`);
    }
    maxOutputTokens = Math.floor(contextTokens / 4); // a small contextWindow from the file: keep room for the conversation
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
      separateEngine: e.OBSCURA_SEPARATE_ENGINE,
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

    agent: {
      /** The agent_* tools are offered only when a model endpoint is configured. */
      enabled: Boolean(agentEndpoint),
      /** Why the sub-agents are off (null when they are on). */
      disabledReason,
      endpoint: agentEndpoint ?? null,
      apiKey: explicit('AGENT_LLM_API_KEY') ? e.AGENT_LLM_API_KEY : (fileModel?.apiKey ?? e.AGENT_LLM_API_KEY),
      model: fileModel?.id ?? e.AGENT_LLM_MODEL ?? null,
      temperature: fromFile('AGENT_LLM_TEMPERATURE', fileModel?.temperature, e.AGENT_LLM_TEMPERATURE),
      topP: fromFile('AGENT_LLM_TOP_P', fileModel?.topP, e.AGENT_LLM_TOP_P),
      maxTokensField: maxTokensField as 'max_tokens' | 'max_completion_tokens',
      reasoningEffort,
      thinking: agentThinking ?? null,
      streaming: fromFile('AGENT_LLM_STREAMING', fileModel?.streaming, e.AGENT_LLM_STREAMING),
      extraBody: { ...fileModel?.extraBody, ...agentExtraBody },
      requestTimeoutMs: e.AGENT_LLM_TIMEOUT_MS,
      contextTokens,
      maxOutputTokens,
      /** Where the model settings come from: config/models.json (with the env overrides) or the AGENT_LLM_* variables. */
      source: fileModel
        ? {
            type: 'file' as const,
            file: fileModel.file,
            provider: fileModel.provider,
            vendor: fileModel.vendor,
            name: fileModel.name,
            available: fileModel.available,
            overrides,
            warnings: agentWarnings,
          }
        : { type: 'env' as const, warnings: agentWarnings },
      maxSteps: e.AGENT_MAX_STEPS,
      maxRuntimeMs: e.AGENT_MAX_RUNTIME_MS,
      maxConcurrent: e.AGENT_MAX_CONCURRENT,
      waitSeconds: e.AGENT_WAIT_SECONDS,
      maxResultChars: e.AGENT_MAX_RESULT_CHARS,
      searchEngine: searchEngine as 'duckduckgo' | 'bing',
      transcripts: e.AGENT_TRANSCRIPTS,
      replyTimeoutMs: e.AGENT_REPLY_TIMEOUT_MS,
      maxQuestions: e.AGENT_MAX_QUESTIONS,
      /** Sub-agents may save a sign-in as a snapshot (save_sign_in). */
      snapshotSave: e.AGENT_SNAPSHOT_SAVE,
    },

    scripts: {
      dir: e.SCRIPTS_DIR ?? path.join(PROJECT_ROOT, 'data', 'scripts'),
      timeoutMs: e.SCRIPT_TIMEOUT_MS,
      memoryBytes: e.SCRIPT_MEMORY_MB * 1024 * 1024,
    },

    snapshots: {
      dir: e.SNAPSHOTS_DIR ?? path.join(PROJECT_ROOT, 'data', 'snapshots'),
      /** Encryption key of the saved states (never logged). */
      key: e.SNAPSHOTS_KEY,
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

/** The models file to read: AGENT_MODELS_FILE ("none" turns it off), else the default when it exists. */
function resolveModelsFile(setting: string | undefined, fallback: string | undefined): string | null {
  if (setting !== undefined) {
    if (['none', 'off'].includes(setting.toLowerCase())) return null;
    const file = path.resolve(setting);
    if (!existsSync(file)) throw new ConfigError(`Invalid configuration:\n  - AGENT_MODELS_FILE: ${file} does not exist`);
    return file;
  }
  return fallback && existsSync(fallback) ? fallback : null;
}

/** Local development: prefer the binary fetched by `npm run obscura:download`. */
function resolveDefaultObscuraBin(): string {
  const local = path.join(PROJECT_ROOT, '.obscura', process.platform === 'win32' ? 'obscura.exe' : 'obscura');
  if (existsSync(local)) return local;
  return 'obscura';
}

/**
 * Accept a base URL (`http://host:8000`, `http://host:8000/v1`) or the full chat completions URL and
 * return the chat completions URL.
 */
export function chatCompletionsUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`expected an http(s) URL such as http://127.0.0.1:8000/v1, got "${redactUrl(input)}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`expected an http(s) URL, got "${redactUrl(input)}"`);
  const p = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(p)) url.pathname = p;
  else if (/\/v\d+$/.test(p)) url.pathname = `${p}/chat/completions`;
  else url.pathname = `${p}/v1/chat/completions`;
  return url.toString();
}

/** A URL for an error message: without user info, query or fragment, which can hold credentials. */
function redactUrl(input: string): string {
  try {
    const u = new URL(input);
    if (['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(u.protocol)) {
      u.username = '';
      u.password = '';
      u.search = '';
      u.hash = '';
      return u.toString();
    }
  } catch {
    // not a URL: strip by pattern below
  }
  // other schemes keep "user:secret@" in the path, so remove it by pattern
  return input.replace(/[?#].*$/s, '').replace(/^([^/]*\/\/)?[^/@]*@/, '$1');
}

/** Split a shell-like argument string, honouring simple single/double quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}
