import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compactHistory,
  formatToolResult,
  parseToolArguments,
  selectTools,
  splitThinking,
  toOpenAITool,
  type AgentResult,
  type ChatMessage,
} from '../../scripts/lmstudio-agent.ts';
import { SCENARIOS, verifyActivity, type RunRecord } from '../../scripts/lmstudio-e2e.ts';

describe('lmstudio agent helpers', () => {
  test('parseToolArguments accepts objects, fenced JSON and empty input', () => {
    assert.deepEqual(parseToolArguments('{"url":"https://a.test"}'), { ok: true, value: { url: 'https://a.test' } });
    assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseToolArguments('  '), { ok: true, value: {} });
    assert.equal(parseToolArguments('[1,2]').ok, false);
    assert.equal(parseToolArguments('{"url": ').ok, false);
  });

  test('splitThinking separates <think> blocks from the answer', () => {
    assert.deepEqual(splitThinking('<think>plan</think>\n\nAnswer'), { reasoning: 'plan', content: 'Answer' });
    assert.deepEqual(splitThinking('Answer<think>unfinished'), { reasoning: 'unfinished', content: 'Answer' });
    assert.deepEqual(splitThinking('plan only</think>Answer'), { reasoning: 'plan only', content: 'Answer' });
    assert.deepEqual(splitThinking('Plain answer'), { reasoning: '', content: 'Plain answer' });
  });

  test('toOpenAITool strips $schema and always has an object schema', () => {
    const t = toOpenAITool({ name: 'x', description: 'd', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } } as any);
    assert.deepEqual(t, { type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } } });
  });

  test('formatToolResult marks errors and replaces images when vision is off', () => {
    const r = formatToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] } as any, 1000, false);
    assert.equal(r.text, 'Error: boom');
    const img = formatToolResult({ content: [{ type: 'text', text: 'shot' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } as any, 1000, false);
    assert.equal(img.images.length, 0);
    assert.match(img.text, /vision is off/);
    assert.match(formatToolResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] } as any, 10, true).text, /truncated 40 characters/);
  });

  test('selectTools rejects unknown toolsets instead of silently dropping them', async () => {
    const tools = [{ name: 'browser_navigate' }, { name: 'browser_fill_form' }, { name: 'browser_evaluate' }] as any[];
    assert.deepEqual((await selectTools(tools, undefined, ['CORE'])).map((t) => t.name), ['browser_navigate']);
    await assert.rejects(selectTools(tools, undefined, ['core', 'formz']), /Unknown toolset\(s\): formz/);
    assert.deepEqual((await selectTools(tools, ['browser_evaluate'], ['core'])).map((t) => t.name), ['browser_navigate', 'browser_evaluate']);
  });

  test('compactHistory shortens old results, keeps one image and fits a context budget', () => {
    const big = 'x'.repeat(10_000);
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: String(i), type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: String(i), content: big });
      messages.push({ role: 'user', content: [{ type: 'text', text: 'img' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
    }
    compactHistory(messages);
    const tools = messages.filter((m) => m.role === 'tool').map((m) => (m.content as string).length);
    assert.ok(tools[0] < 2_000 && tools[1] < 2_000, 'results older than the last six are shortened');
    assert.deepEqual(tools.slice(2), [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    const images = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url');
    assert.equal(images.length, 1);

    compactHistory(messages, 25_000);
    const fitted = messages.filter((m) => m.role === 'tool').map((m) => (m.content as string).length);
    assert.equal(fitted[fitted.length - 1], 10_000, 'the newest result stays whole');
    const chars = (m: ChatMessage) =>
      typeof m.content === 'string' ? m.content.length : (m.content ?? []).reduce((n, p) => n + (p.type === 'text' ? p.text.length : 4_000), 0);
    const total = messages.reduce((n, m) => n + chars(m) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    assert.ok(total <= 25_000, `conversation fits the budget (${total} chars)`);
  });
});

describe('lmstudio e2e assertions', () => {
  const result = (toolCalls: Array<{ name: string; args: unknown }>, finalAnswer = 'ok'): AgentResult =>
    ({
      ok: true,
      stopReason: 'final_answer',
      finalAnswer,
      toolCalls: toolCalls.map((c, i) => ({ step: i + 1, id: String(i), name: c.name, args: c.args, isError: false, executed: true, durationMs: 1, result: 'ok', images: 0 })),
    }) as unknown as AgentResult;
  const runRecord = (startedAt: string, r: AgentResult): RunRecord => ({
    scenario: 'a',
    name: 'read page',
    run: 1,
    status: 'pass',
    steps: 1,
    toolCalls: r.toolCalls.length,
    durationMs: 1,
    failures: [],
    tools: [],
    answer: r.finalAnswer,
    startedAt,
    result: r,
  });

  test('the preflight navigate does not count as the agent\'s own call', () => {
    const t0 = Date.parse('2026-09-17T10:00:00.000Z');
    const url = 'http://127.0.0.1:5000/index.html';
    const state = {
      history: {
        logs: [],
        activity: [{ id: 'p1', tool: 'browser_navigate', client: 'lmstudio-e2e-preflight 1.0.0', status: 'ok', args: { url }, startedAt: new Date(t0 - 300).toISOString() }],
      },
    };
    const run = runRecord(new Date(t0).toISOString(), result([{ name: 'browser_navigate', args: { url } }]));
    const missing = verifyActivity(state, [run]);
    assert.equal(missing.verified, 0);
    assert.match(missing.failures.join('\n'), /browser_navigate .* is missing from the server activity feed/);

    state.history.activity.push({ id: 'a1', tool: 'browser_navigate', client: 'lmstudio-e2e 1.0.0', status: 'ok', args: { url }, startedAt: new Date(t0 + 20_000).toISOString() });
    const found = verifyActivity(state, [run]);
    assert.deepEqual(found.failures, []);
    assert.equal(found.verified, 1);
  });

  test('scenario a requires the exact Pear price', () => {
    const a = SCENARIOS.find((s) => s.id === 'a')!;
    const check = (answer: string) => a.check({ fx: {} as any, requests: [], result: result([{ name: 'browser_navigate', args: {} }], answer) });
    assert.deepEqual(check('The heading is "Hello Fixture" and Pear costs $2.'), []);
    assert.deepEqual(check('Hello Fixture; Pear: $2.00'), []);
    assert.deepEqual(check('Hello Fixture; Pear costs $20'), ['answer lacks the price "$2"']);
  });
});
