import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chatCompletionsUrl, loadConfig } from '../../src/config.ts';
import { enabledTools } from '../../src/tools/index.ts';
import { loadModelsFile, parseJsonc } from '../../src/models-config.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'sws-models-'));
let n = 0;
/** Write a models file (a value is serialized; a string is written as is). */
const file = (content: unknown): string => {
  const p = path.join(dir, `models-${++n}.json`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
};
const model = (extra: Record<string, unknown> = {}) => ({ id: 'm1', url: 'http://10.0.0.5:8000/v1', toolCalling: true, ...extra });
const provider = (extra: Record<string, unknown> = {}) => ({ name: 'Local', models: [model()], ...extra });

describe('parseJsonc', () => {
  test('accepts comments and trailing commas, and leaves strings alone', () => {
    const { value, duplicates } = parseJsonc(`﻿{
      // a line comment
      "url": "http://h/v1//x", /* a block
      comment over lines */ "note": "a /* not a comment */, b // nor this",
      "q": "say \\"hi\\", ok",
      "list": [1, 2, 3,],
    }`);
    assert.deepEqual(value, { url: 'http://h/v1//x', note: 'a /* not a comment */, b // nor this', q: 'say "hi", ok', list: [1, 2, 3] });
    assert.deepEqual(duplicates, []);
  });

  test('reports keys that appear twice in one object, with their line', () => {
    const { value, duplicates } = parseJsonc('{\n "a": 1,\n "b": {"a": 2},\n "a": 3\n}');
    assert.deepEqual(value, { a: 3, b: { a: 2 } });
    assert.deepEqual(duplicates, [{ key: 'a', line: 4 }]);
  });

  test('finds duplicate keys when a comment sits before the colon; numbers with exponents are fine', () => {
    assert.deepEqual(parseJsonc('{"a" /* c */ : 1, "a": 2}').duplicates, [{ key: 'a', line: 1 }]);
    assert.deepEqual(parseJsonc('{"a": 1,\n "b" // x\n : 2, "b": 3}').duplicates, [{ key: 'b', line: 3 }]);
    assert.deepEqual(parseJsonc('{"a": "x" /* c */, "b": 1}').duplicates, []);
    assert.deepEqual(parseJsonc('{"a": 1e5, "b": -2.5E-3, "c": [true, false, null]}').value, { a: 100000, b: -0.0025, c: [true, false, null] });
  });

  test('syntax errors name the line and never quote the text, which may be a key', () => {
    for (const [text, expected] of [
      ['{\n  "apiKey": sk-proj-SECRETabc123\n}', /line 2: text without double quotes/],
      ["{\n\n  'apiKey': 'sk-SECRETabc123'\n}", /line 3: use double quotes/],
      ['{"apiKey": "sk-SECRETabc123" "url": 1}', /is not valid JSON: .*line 1 column/],
    ] as const) {
      assert.throws(
        () => parseJsonc(text, 'f.json'),
        (err: Error) => expected.test(err.message) && !/SECRET/.test(err.message),
      );
    }
  });

  test('keeps line numbers in JSON errors after multi-line comments', () => {
    assert.throws(() => parseJsonc('{\n/*\n\n*/\n "a": 1 oops\n}', 'f.json'), /f\.json line 5: text without double quotes/);
    assert.throws(() => parseJsonc('{\n/*\n\n*/\n "a": 1 2\n}', 'f.json'), /f\.json is not valid JSON: .*line 5/);
    assert.throws(() => parseJsonc('{"a": "unterminated\n}'), /line 1: unterminated string/);
    assert.throws(() => parseJsonc('{"a": 1 /* open'), /unterminated \/\* comment/);
  });
});

describe('models file', () => {
  test('reads the editor-style provider list, including a duplicated settings key (the last wins)', () => {
    const text = `[
      {
        "name": "Local vLLM",
        "vendor": "customendpoint",
        "apiKey": "local-key",
        "apiType": "chat-completions",
        "models": [
          {
            "id": "qwen3.8-27b",
            "name": "Qwen 27B",
            "url": "http://10.0.0.5:8000/v1/chat/completions",
            "toolCalling": true,
            "vision": false,
            "streaming": true,
            "contextWindow": 262144,
            "maxOutputTokens": 32768,
            "thinking": true,
            "supportsReasoningEffort": ["low", "medium", "xhigh"],
            "reasoningEffortFormat": "chat-completions",
            "modelOptions": { "temperature": 0.4, "top_p": 0.95, "top_k": 20 }
          }
        ],
        "settings": { "qwen3.8-27b": { "reasoningEffort": "xhigh" } },
        "settings": { "qwen3.8-27b": { "reasoningEffort": "medium" } }
      }
    ]`;
    const m = loadModelsFile(file(text), {});
    assert.equal(m.provider, 'Local vLLM');
    assert.equal(m.vendor, 'customendpoint');
    assert.equal(m.id, 'qwen3.8-27b');
    assert.equal(m.name, 'Qwen 27B');
    assert.equal(m.apiKey, 'local-key');
    assert.equal(m.reasoningEffort, 'medium');
    assert.equal(m.temperature, 0.4);
    assert.equal(m.topP, 0.95);
    assert.deepEqual(m.extraBody, { top_k: 20 });
    assert.equal(m.contextWindow, 262144);
    assert.equal(m.maxOutputTokens, 32768);
    assert.equal(m.streaming, true);
    assert.equal(m.warnings.length, 1);
    assert.match(m.warnings[0]!, /line 24: "settings" appears more than once/);
  });

  test('picks a model by id, "provider/id" or display name; by default the first tool-calling one', () => {
    const p = file([
      { name: 'A', models: [model({ id: 'no-tools', toolCalling: false }), model({ id: 'a1', name: 'Alpha One' })] },
      { name: 'B', url: 'http://10.0.0.6:1234/v1', models: [{ id: 'shared' }] },
      { name: 'C', models: [model({ id: 'shared', url: 'http://10.0.0.7:1/v1' })] },
    ]);
    const first = loadModelsFile(p, {});
    assert.equal(first.id, 'a1');
    assert.match(first.warnings.join('\n'), /skipped models with "toolCalling": false/);
    assert.equal(loadModelsFile(p, {}, 'shared').url, 'http://10.0.0.6:1234/v1', 'the provider url is the fallback');
    assert.equal(loadModelsFile(p, {}, 'c/shared').url, 'http://10.0.0.7:1/v1');
    assert.equal(loadModelsFile(p, {}, 'alpha one').id, 'a1');
    // every entry of the list that errors and config:check print can be used as it is
    for (const entry of first.available.filter((e) => !e.endsWith('no-tools'))) assert.ok(loadModelsFile(p, {}, entry).id, entry);
    assert.equal(loadModelsFile(p, {}, 'C / shared').url, 'http://10.0.0.7:1/v1');
    assert.throws(() => loadModelsFile(p, {}, 'missing'), /"missing" is not in .*A \/ no-tools, A \/ a1, B \/ shared, C \/ shared/);
    assert.throws(() => loadModelsFile(p, {}, 'no-tools'), /toolCalling": false/);
    assert.throws(() => loadModelsFile(file([{ name: 'X', models: [model({ toolCalling: false })] }]), {}), /no model supports tool calling/);
  });

  test('a single provider object works too', () => {
    assert.equal(loadModelsFile(file(provider()), {}).id, 'm1');
  });

  test('reasoning effort: the setting, else "medium" when offered; left out when the model takes none', () => {
    const effort = (m: Record<string, unknown>, settings?: Record<string, unknown>) =>
      loadModelsFile(file([provider({ models: [model(m)], ...(settings ? { settings: { m1: settings } } : {}) })]), {}).reasoningEffort;
    assert.equal(effort({}), undefined, 'the file does not say: the AGENT_LLM_REASONING_EFFORT default applies');
    assert.equal(effort({ supportsReasoningEffort: ['low', 'medium'] }), 'medium');
    assert.equal(effort({ supportsReasoningEffort: ['low', 'high'] }), null);
    assert.equal(effort({ supportsReasoningEffort: ['low', 'HIGH'] }, { reasoningEffort: 'high' }), 'high');
    assert.equal(effort({ supportsReasoningEffort: [] }), null);
    assert.equal(effort({ reasoningEffortFormat: 'none' }, { reasoningEffort: 'low' }), null);
    assert.equal(effort({}, { reasoningEffort: 'xhigh' }), 'xhigh', 'without a list any value is sent');
    assert.throws(() => effort({ supportsReasoningEffort: ['low'] }, { reasoningEffort: 'max' }), /"max" is not in supportsReasoningEffort \(low\)/);
    assert.throws(() => effort({ reasoningEffortFormat: 'responses' }), /reasoningEffortFormat: expected one of: chat-completions, none/);
  });

  test('modelOptions: sampling is validated, null leaves it out, fields the server owns are refused', () => {
    const opts = (o: Record<string, unknown>) => loadModelsFile(file([provider({ models: [model({ modelOptions: o })] })]), {});
    assert.equal(opts({ temperature: null }).temperature, null);
    assert.equal(opts({}).temperature, undefined);
    assert.deepEqual(opts({ min_p: 0.05, repetition_penalty: 1.05 }).extraBody, { min_p: 0.05, repetition_penalty: 1.05 });
    assert.throws(() => opts({ temperature: 3 }), /temperature must be a number between 0 and 2/);
    assert.throws(() => opts({ top_p: '0.9' }), /top_p must be a number between 0 and 1/);
    assert.throws(() => opts({ stream: false, max_tokens: 5 }), /cannot set stream, max_tokens/);
  });

  test('${VAR} in apiKey and url comes from the environment', () => {
    const p = file([provider({ apiKey: '${MY_KEY}', models: [model({ url: 'http://${LLM_HOST}:8000/v1' })] })]);
    const m = loadModelsFile(p, { MY_KEY: 'from-env', LLM_HOST: '10.1.2.3' });
    assert.equal(m.apiKey, 'from-env');
    assert.equal(m.url, 'http://10.1.2.3:8000/v1');
    assert.throws(() => loadModelsFile(p, { LLM_HOST: 'h' }), /apiKey uses \$\{MY_KEY\}, but the environment variable MY_KEY is not set/);
  });

  test('clear errors for invalid files; warnings for unknown fields and orphan settings', () => {
    assert.throws(() => loadModelsFile(path.join(dir, 'nope.json'), {}), /cannot read/);
    assert.throws(() => loadModelsFile(file([]), {}), /must list at least one provider/);
    assert.throws(() => loadModelsFile(file([{ name: 'X', models: [] }]), {}), /\[0\]\.models: must list at least one model/);
    assert.throws(() => loadModelsFile(file([{ name: 'X', models: [{ id: 'm' }] }]), {}), /has no "url"/);
    assert.throws(() => loadModelsFile(file([provider({ apiType: 'responses' })]), {}), /only "chat-completions"/);
    assert.throws(() => loadModelsFile(file({ name: 'X', models: [{ url: 'http://h/v1' }] }), {}), /models\[0\]\.id/);
    const m = loadModelsFile(file([provider({ colour: 'blue', models: [model({ contextWindows: 5 })], settings: { other: { reasoningEffort: 'low' }, m1: { temp: 1 } } })]), {});
    assert.deepEqual(
      m.warnings.map((w) => w.replace(/^\S+: /, '')),
      [
        'unknown field [0].colour is ignored',
        'unknown field [0].models[0].contextWindows is ignored',
        'settings for "other" in provider "Local" match none of its models',
        'unknown setting [0].settings.m1.temp is ignored',
      ],
    );
  });
});

describe('models file in the server configuration', () => {
  const base = { models: [model({ contextWindow: 262144, maxOutputTokens: 32768, supportsReasoningEffort: ['low', 'medium'], modelOptions: { temperature: 0.3 } })] };

  test('the file configures the sub-agents; environment variables override it field by field', () => {
    const p = file([provider({ apiKey: 'file-key', ...base })]);
    const a = loadConfig({ AGENT_MODELS_FILE: p }).agent;
    assert.equal(a.enabled, true);
    assert.equal(a.endpoint, 'http://10.0.0.5:8000/v1/chat/completions');
    assert.equal(a.model, 'm1');
    assert.equal(a.apiKey, 'file-key');
    assert.equal(a.temperature, 0.3);
    assert.equal(a.topP, 0.95, 'not in the file: the AGENT_LLM_TOP_P default');
    assert.equal(a.reasoningEffort, 'medium');
    assert.equal(a.contextTokens, 65536, 'the agent budget, not the whole context window');
    assert.equal(a.maxOutputTokens, 8192);
    assert.equal(a.source.type, 'file');
    assert.equal(a.source.type === 'file' && a.source.provider, 'Local');

    const o = loadConfig({
      AGENT_MODELS_FILE: p,
      AGENT_LLM_URL: 'http://10.9.9.9:1/v1',
      AGENT_LLM_API_KEY: 'env-key',
      AGENT_LLM_TEMPERATURE: 'none',
      AGENT_LLM_REASONING_EFFORT: 'low',
      AGENT_LLM_STREAMING: 'false',
      AGENT_LLM_EXTRA_BODY: '{"top_k": 5}',
    }).agent;
    assert.equal(o.endpoint, 'http://10.9.9.9:1/v1/chat/completions');
    assert.equal(o.apiKey, 'env-key');
    assert.equal(o.temperature, null);
    assert.equal(o.reasoningEffort, 'low');
    assert.equal(o.streaming, false);
    assert.deepEqual(o.extraBody, { top_k: 5 });
    assert.deepEqual(o.source.type === 'file' && o.source.overrides, [
      'AGENT_LLM_URL',
      'AGENT_LLM_API_KEY',
      'AGENT_LLM_TEMPERATURE',
      'AGENT_LLM_REASONING_EFFORT',
      'AGENT_LLM_STREAMING',
    ]);
  });

  test('the model limits cap the agent budget', () => {
    const small = file([provider({ models: [model({ contextWindow: 16384, maxOutputTokens: 12000 })] })]);
    const a = loadConfig({ AGENT_MODELS_FILE: small }).agent;
    assert.equal(a.contextTokens, 16384);
    assert.equal(a.maxOutputTokens, 4096, 'shrunk to leave room for the conversation');
    const b = loadConfig({ AGENT_MODELS_FILE: small, AGENT_CONTEXT_TOKENS: '131072' }).agent;
    assert.equal(b.contextTokens, 16384);
    assert.match(b.source.warnings.join('\n'), /AGENT_CONTEXT_TOKENS 131072 is more than the model's contextWindow/);
    assert.throws(() => loadConfig({ AGENT_MODELS_FILE: small, AGENT_MAX_OUTPUT_TOKENS: '9000' }), /AGENT_MAX_OUTPUT_TOKENS: must be less than half of the context budget \(16384/);
    assert.throws(() => loadConfig({ AGENT_MODELS_FILE: file([provider({ models: [model({ contextWindow: 4096 })] })]) }), /too small for sub-agents/);
  });

  test('URLs in error messages lose their credentials and query', () => {
    for (const [input, env] of [
      ['host.docker.internal:1234/v1?key=${K}', { K: 'SUPERSECRET' }],
      ['ws://user:SUPERSECRET@h/v1', {}],
      ['user:SUPERSECRET@h/v1', {}],
    ] as const) {
      const p = file([provider({ models: [model({ url: input })] })]);
      assert.throws(
        () => loadConfig({ AGENT_MODELS_FILE: p, ...env }),
        (err: Error) => /expected an http\(s\) URL/.test(err.message) && !err.message.includes('SUPERSECRET'),
      );
      assert.throws(() => chatCompletionsUrl(input.replace('${K}', 'SUPERSECRET')), (err: Error) => !err.message.includes('SUPERSECRET'));
    }
  });

  test('why the sub-agents are off, and invalid TOOLSETS as a configuration error', () => {
    assert.equal(loadConfig({}, { defaultModelsFile: '/app/config/models.json' }).agent.disabledReason, 'no /app/config/models.json and AGENT_LLM_URL is not set');
    assert.match(loadConfig({ AGENT_MODELS_FILE: 'none' }).agent.disabledReason ?? '', /AGENT_MODELS_FILE=none/);
    assert.equal(loadConfig({ AGENT_MODELS_FILE: file([provider()]) }).agent.disabledReason, null);
    assert.throws(() => enabledTools(loadConfig({ TOOLSETS: 'core,foo' })), (err: Error) => err.name === 'Error' && /Invalid configuration:\n {2}- TOOLSETS: unknown groups or tools: foo/.test(err.message));
  });

  test('where the file comes from: AGENT_MODELS_FILE, the default path, or none', () => {
    const p = file([provider()]);
    assert.equal(loadConfig({}).agent.enabled, false, 'no default path given: the file is not looked for');
    assert.equal(loadConfig({}, { defaultModelsFile: p }).agent.model, 'm1');
    assert.equal(loadConfig({}, { defaultModelsFile: path.join(dir, 'absent.json') }).agent.enabled, false);
    assert.equal(loadConfig({ AGENT_MODELS_FILE: 'none' }, { defaultModelsFile: p }).agent.enabled, false);
    assert.throws(() => loadConfig({ AGENT_MODELS_FILE: path.join(dir, 'absent.json') }), /AGENT_MODELS_FILE: .*absent\.json does not exist/);
    assert.throws(() => loadConfig({ AGENT_MODELS_FILE: file([provider({ models: [model({ url: 'ftp://h' })] })]) }), /AGENT_MODELS_FILE: .*url: expected an http\(s\) URL/);
    assert.equal(loadConfig({ AGENT_MODELS_FILE: p, AGENT_LLM_MODEL: 'm1' }).agent.model, 'm1');
    assert.throws(() => loadConfig({ AGENT_MODELS_FILE: p, AGENT_LLM_MODEL: 'other' }), /AGENT_LLM_MODEL "other" is not in/);
  });

  test('the example file in the repository is valid', () => {
    const example = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'models.example.json');
    const m = loadModelsFile(example, {});
    assert.equal(m.provider, 'Local vLLM');
    assert.deepEqual(m.warnings, []);
    assert.deepEqual(m.available, ['Local vLLM / qwen3.8-27b', 'LM Studio / qwen/qwen3.8-27b']);
    const lm = loadConfig({ AGENT_MODELS_FILE: example, AGENT_LLM_MODEL: 'qwen/qwen3.8-27b' }).agent;
    assert.equal(lm.endpoint, 'http://host.docker.internal:1234/v1/chat/completions');
    assert.equal(lm.reasoningEffort, 'low');
    assert.equal(lm.contextTokens, 32768);
    assert.equal(lm.maxOutputTokens, 8192);
  });
});
