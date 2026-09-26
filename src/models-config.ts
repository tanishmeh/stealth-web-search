import { readFileSync } from 'node:fs';
import * as z from 'zod';

/**
 * The sub-agents' model, read from a JSON file (config/models.json) in the provider format used by
 * editors' "custom endpoint" model lists: an array of providers, each with its models and per-model
 * settings. docs/MODELS.md describes every field. Comments and trailing commas are accepted, and a key
 * that appears twice in one object is reported (JSON keeps the last one).
 */

const REASONING_FORMATS = ['chat-completions', 'none'] as const;
/** Request fields the server sets itself; modelOptions cannot replace them. */
const RESERVED_OPTIONS = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'reasoning_effort'];

const ModelSchema = z.looseObject({
  id: z.string().trim().min(1, 'is required'),
  name: z.string().optional(),
  url: z.string().trim().min(1).optional(),
  toolCalling: z.boolean().optional(),
  vision: z.boolean().optional(),
  streaming: z.boolean().optional(),
  contextWindow: z.number().int().min(1_024).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  thinking: z.boolean().optional(),
  supportsReasoningEffort: z.array(z.string().trim().min(1)).optional(),
  reasoningEffortFormat: z.enum(REASONING_FORMATS, { error: `expected one of: ${REASONING_FORMATS.join(', ')}` }).optional(),
  modelOptions: z.record(z.string(), z.unknown()).optional(),
});

const SettingsSchema = z.looseObject({
  reasoningEffort: z.string().trim().min(1).optional(),
});

const ProviderSchema = z.looseObject({
  name: z.string().trim().min(1, 'is required'),
  vendor: z.string().optional(),
  apiKey: z.string().optional(),
  apiType: z.literal('chat-completions', { error: 'only "chat-completions" (OpenAI-compatible /v1/chat/completions) is supported' }).optional(),
  /** Default endpoint for models without their own url. */
  url: z.string().trim().min(1).optional(),
  models: z.array(ModelSchema).min(1, 'must list at least one model'),
  settings: z.record(z.string(), SettingsSchema).optional(),
});

const ProvidersSchema = z.array(ProviderSchema).min(1, 'must list at least one provider');

const KNOWN_MODEL_KEYS = new Set(Object.keys(ModelSchema.shape));
const KNOWN_PROVIDER_KEYS = new Set(Object.keys(ProviderSchema.shape));
const KNOWN_SETTING_KEYS = new Set(Object.keys(SettingsSchema.shape));

/** The model the sub-agents use, as the file describes it. Unset fields fall back to the AGENT_* variables. */
export interface FileModel {
  file: string;
  provider: string;
  vendor: string | null;
  id: string;
  name: string | null;
  url: string;
  apiKey: string | undefined;
  streaming: boolean | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  vision: boolean | undefined;
  thinking: boolean | undefined;
  /** undefined: the file does not say; null: leave reasoning_effort out; else the value to send. */
  reasoningEffort: string | null | undefined;
  temperature: number | null | undefined;
  topP: number | null | undefined;
  /** modelOptions other than temperature and top_p, merged into every request. */
  extraBody: Record<string, unknown>;
  /** Every model in the file, as "provider / id". */
  available: string[];
  warnings: string[];
}

export class ModelsFileError extends Error {}

/**
 * Read `file` and pick the model: `select` (AGENT_LLM_MODEL) matches a model id, "provider/id" or a
 * display name; without it the first model that supports tool calling is used.
 */
export function loadModelsFile(file: string, env: NodeJS.ProcessEnv, select?: string): FileModel {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const hint = code === 'EACCES' ? ' The server runs as uid 1000 in Docker: make the file readable by that user (see docs/MODELS.md).' : '';
    throw new ModelsFileError(`cannot read ${file}: ${(err as Error).message}.${hint}`);
  }
  const { value, duplicates } = parseJsonc(text, file);
  // an array of providers, or a single provider object
  const parsed = ProvidersSchema.safeParse(Array.isArray(value) ? value : [value]);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${formatPath(Array.isArray(value) ? i.path : i.path.slice(1))}: ${i.message}`)
      .join('; ');
    throw new ModelsFileError(`${file} is not a valid models file: ${details}`);
  }
  const providers = parsed.data;
  const warnings = duplicates.map((d) => `${file} line ${d.line}: "${d.key}" appears more than once in the same object; the last one is used`);

  providers.forEach((p, pi) => {
    for (const key of Object.keys(p)) if (!KNOWN_PROVIDER_KEYS.has(key)) warnings.push(`${file}: unknown field ${formatPath([pi, key])} is ignored`);
    p.models.forEach((m, mi) => {
      for (const key of Object.keys(m)) if (!KNOWN_MODEL_KEYS.has(key)) warnings.push(`${file}: unknown field ${formatPath([pi, 'models', mi, key])} is ignored`);
    });
    for (const [id, s] of Object.entries(p.settings ?? {})) {
      if (!p.models.some((m) => m.id === id)) warnings.push(`${file}: settings for "${id}" in provider "${p.name}" match none of its models`);
      for (const key of Object.keys(s)) if (!KNOWN_SETTING_KEYS.has(key)) warnings.push(`${file}: unknown setting ${formatPath([pi, 'settings', id, key])} is ignored`);
    }
  });

  const all = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const available = all.map(({ provider, model }) => `${provider.name} / ${model.id}`);
  let chosen: (typeof all)[number] | undefined;
  if (select) {
    const want = select.trim();
    const lower = want.toLowerCase();
    chosen =
      all.find(({ model }) => model.id === want) ??
      // "provider/id", or "provider / id" as the list below prints it
      all.find(({ provider, model }) => [`${provider.name}/${model.id}`, `${provider.name} / ${model.id}`].some((s) => s.toLowerCase() === lower)) ??
      all.find(({ model }) => model.name?.trim().toLowerCase() === lower);
    if (!chosen) throw new ModelsFileError(`AGENT_LLM_MODEL "${want}" is not in ${file}. Models in the file: ${available.join(', ')}`);
    if (chosen.model.toolCalling === false) {
      throw new ModelsFileError(`${file}: model "${chosen.model.id}" has "toolCalling": false; sub-agents need a model that supports tool calling`);
    }
  } else {
    chosen = all.find(({ model }) => model.toolCalling !== false);
    if (!chosen) throw new ModelsFileError(`${file}: no model supports tool calling ("toolCalling": false on all of them); sub-agents need one`);
    if (chosen !== all[0]) warnings.push(`${file}: skipped models with "toolCalling": false; using "${chosen.model.id}"`);
  }
  const { provider, model } = chosen;
  const where = `${file} (${provider.name} / ${model.id})`;

  const rawUrl = model.url ?? provider.url;
  if (!rawUrl) throw new ModelsFileError(`${where}: the model has no "url" (and the provider has none either)`);
  const url = interpolate(rawUrl, env, `${where} url`);
  const apiKey = provider.apiKey === undefined ? undefined : interpolate(provider.apiKey, env, `${where} apiKey`).trim() || undefined;

  // reasoning effort: settings.<id>.reasoningEffort, else "medium" when the model offers it
  const offered = model.supportsReasoningEffort?.map((e) => e.toLowerCase());
  const setting = provider.settings?.[model.id]?.reasoningEffort?.toLowerCase();
  let reasoningEffort: string | null | undefined;
  if (model.reasoningEffortFormat === 'none' || (offered && offered.length === 0)) {
    reasoningEffort = null;
    if (setting) warnings.push(`${where}: reasoningEffort "${setting}" is ignored because the model does not take one`);
  } else if (setting) {
    if (offered && !offered.includes(setting)) {
      throw new ModelsFileError(`${where}: reasoningEffort "${setting}" is not in supportsReasoningEffort (${offered.join(', ')})`);
    }
    reasoningEffort = setting;
  } else if (offered) {
    reasoningEffort = offered.includes('medium') ? 'medium' : null;
  }

  const options = { ...model.modelOptions };
  const reserved = Object.keys(options).filter((k) => RESERVED_OPTIONS.includes(k));
  if (reserved.length) {
    throw new ModelsFileError(
      `${where}: modelOptions cannot set ${reserved.join(', ')} (the server sets these; use maxOutputTokens, streaming and settings.reasoningEffort instead)`,
    );
  }
  const temperature = sampling(options, 'temperature', 0, 2, where);
  const topP = sampling(options, 'top_p', 0, 1, where);
  delete options.temperature;
  delete options.top_p;

  return {
    file,
    provider: provider.name,
    vendor: provider.vendor ?? null,
    id: model.id,
    name: model.name?.trim() || null,
    url,
    apiKey,
    streaming: model.streaming,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    vision: model.vision,
    thinking: model.thinking,
    reasoningEffort,
    temperature,
    topP,
    extraBody: options,
    available,
    warnings,
  };
}

function sampling(options: Record<string, unknown>, key: string, min: number, max: number, where: string): number | null | undefined {
  if (!(key in options)) return undefined;
  const v = options[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ModelsFileError(`${where}: modelOptions.${key} must be a number between ${min} and ${max} (or null to leave it out)`);
  }
  return v;
}

/** Replace ${NAME} with the environment variable NAME (so keys can stay in .env). */
function interpolate(value: string, env: NodeJS.ProcessEnv, what: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') throw new ModelsFileError(`${what} uses \${${name}}, but the environment variable ${name} is not set`);
    return v;
  });
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out ? `.${String(p)}` : String(p);
  return out || '(top level)';
}

/**
 * JSON with // and /* *\/ comments and trailing commas. Also reports keys that appear twice in the
 * same object (JSON.parse silently keeps the last one), with their line number.
 */
export function parseJsonc(text: string, file = 'input'): { value: unknown; duplicates: Array<{ key: string; line: number }> } {
  let out = '';
  const duplicates: Array<{ key: string; line: number }> = [];
  // one entry per open bracket: the keys seen so far for an object, null for an array
  const stack: Array<Set<string> | null> = [];
  let line = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  /** The index of the next character that is not whitespace or a comment. */
  const skipTrivia = (k: number): number => {
    for (;;) {
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text.startsWith('//', k)) {
        while (k < text.length && text[k] !== '\n') k++;
      } else if (text.startsWith('/*', k)) {
        const end = text.indexOf('*/', k + 2);
        k = end < 0 ? text.length : end + 2;
      } else return k;
    }
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== '"') throw new ModelsFileError(`${file} line ${line}: unterminated string`);
      const raw = text.slice(i, j + 1);
      out += raw;
      const keys = stack[stack.length - 1];
      if (keys) {
        const k = skipTrivia(j + 1);
        if (text[k] === ':') {
          let key = raw;
          try {
            key = JSON.parse(raw) as string;
          } catch {
            // invalid escapes: JSON.parse below reports them
          }
          if (keys.has(key)) duplicates.push({ key, line });
          keys.add(key);
        }
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ModelsFileError(`${file} line ${line}: unterminated /* comment`);
      const breaks = text.slice(i, end + 2).replace(/[^\n]/g, '');
      line += breaks.length;
      out += breaks || ' '; // keep line numbers for JSON.parse errors
      i = end + 2;
      continue;
    }
    if (ch === ',') {
      // drop a trailing comma: the next significant character closes the object or array
      const k = skipTrivia(i + 1);
      if (text[k] === '}' || text[k] === ']') {
        i++;
        continue;
      }
    }
    // the usual paste mistakes, reported with their line and without quoting the text (it may be a key)
    if (/[-0-9]/.test(ch)) {
      // a number, whole, so an exponent (1e5) is not taken for text
      const num = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))?.[0] || ch;
      out += num;
      i += num.length;
      continue;
    }
    if (ch === "'") throw new ModelsFileError(`${file} line ${line}: use double quotes ("), not single quotes`);
    if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$.-]*/.exec(text.slice(i))![0];
      if (word !== 'true' && word !== 'false' && word !== 'null') {
        throw new ModelsFileError(`${file} line ${line}: text without double quotes (JSON strings and keys need them)`);
      }
      out += word;
      i += word.length;
      continue;
    }
    if (ch === '{') stack.push(new Set());
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') stack.pop();
    if (ch === '\n') line++;
    out += ch;
    i++;
  }
  try {
    return { value: JSON.parse(out), duplicates };
  } catch (err) {
    // V8 can quote the text around the error, which may be part of a key: keep only the description
    const message = (err as Error).message.replace(/,\s*(?:\.\.\.)?".*"(?:\.\.\.)?\s*is not valid JSON$/s, '');
    throw new ModelsFileError(`${file} is not valid JSON: ${message}`);
  }
}
