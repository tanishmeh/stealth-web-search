import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildSystemPrompt,
  compactHistory,
  formatToolResult,
  parseCli,
  parseToolArguments,
  selectTools,
  splitThinking,
  toOpenAITool,
  UsageError,
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

  test('the system prompt: a purchase the task approves is passed as purchase_approval and approved by the host itself; anything else gets "No"', () => {
    const prompt = buildSystemPrompt('server notes', false, undefined, true);
    assert.match(
      prompt,
      /\n- Orders and payments: the sub-agent always asks you \(reason confirm\) before it places an order or pays\. When the user's task explicitly approves the purchase \(for example "I approve", "go ahead and pay", "no need to ask me", or a maximum price such as "up to \$20"\), pass the user's words as purchase_approval to agent_run \(or agent_automate\), and answer the matching confirm question "Yes" yourself when the checkout matches that approval \(item, quantity, total within the limit, address, payment method\)\. A task that only asks you to order or buy something \("order X and give me the order number"\) does not approve the purchase: it says what to buy, not what it may cost\. Then do not pass purchase_approval, reply "No" to the confirm question, and say in your final answer that the order is ready and needs the user's approval, with the item and the total\. Also reply "No" when the checkout differs from the approval or goes beyond it\.\n/,
    );
    assert.match(prompt, /\n- The user cannot answer: reply "No" to any other confirm question \(sending a message, deleting\) that the task did not explicitly approve, and say so in your final answer\.\n/);
    assert.match(prompt, /The user cannot answer questions while you work\./, 'a one-shot run: nobody to ask mid-task');
    assert.doesNotMatch(prompt, /confirm_purchases/);
    assert.ok(prompt.indexOf('Sub-agent questions:') < prompt.indexOf('Notes from the browser server:\nserver notes'));
    // without agent_reply there are no sub-agent questions to answer
    assert.doesNotMatch(buildSystemPrompt('server notes', false, undefined, false), /purchase_approval|Sub-agent questions/);
  });

  test('the interactive system prompt: a purchase the task did not approve is put to the user, whose reply decides the answer', () => {
    const prompt = buildSystemPrompt('server notes', false, undefined, true, true);
    // the approval rule itself is the same in both modes
    assert.match(
      prompt,
      /\n- Orders and payments: the sub-agent always asks you \(reason confirm\) before it places an order or pays\. When the user's task explicitly approves the purchase \(for example "I approve", "go ahead and pay", "no need to ask me", or a maximum price such as "up to \$20"\), pass the user's words as purchase_approval to agent_run \(or agent_automate\), and answer the matching confirm question "Yes" yourself when the checkout matches that approval \(item, quantity, total within the limit, address, payment method\)\. A task that only asks you to order or buy something \("order X and give me the order number"\) does not approve the purchase: it says what to buy, not what it may cost\. Then do not pass purchase_approval\. /,
    );
    assert.match(
      prompt,
      /When the task does not explicitly approve the purchase, do not approve it yourself: end your turn by asking the user \(item, total, delivery address, payment method, the site\); their reply comes back to you, then answer the waiting question with agent_reply \("Yes" only if they approve; "No" otherwise\)\. Do the same when the checkout differs from the approval or goes beyond it\.\n/,
    );
    assert.match(prompt, /\n- Other confirm questions \(sending a message, deleting\) that the task did not explicitly approve: ask the user the same way, and answer with their decision\.\n/);
    assert.match(prompt, /While a run you started is waiting, end your turn only to ask the user a question below; their reply comes back to you\./);
    assert.match(prompt, /Ask the user only to decide a sub-agent question as described below; any other reply without tool calls ends the task as your final answer\./);
    // nothing of the one-shot text that tells the model nobody can answer
    assert.doesNotMatch(prompt, /The user cannot answer/);
    assert.doesNotMatch(prompt, /the order is ready and needs the user's approval/);
    assert.doesNotMatch(prompt, /never end with a final answer while a run you started is waiting/);
    // the rules that do not depend on the user being there
    assert.match(prompt, /\n- Never send a password\. Give a one-time code only if the task contains it; otherwise reply that you do not have it\.\n- Answer only the questions of runs you started in this task/);
    assert.ok(prompt.indexOf('Sub-agent questions:') < prompt.indexOf('Notes from the browser server:\nserver notes'));

    // without sub-agents there is nothing to ask the user about: the one-shot text stays
    const plain = buildSystemPrompt('server notes', false, undefined, false, true);
    assert.match(plain, /The user cannot answer questions while you work\./);
    assert.doesNotMatch(plain, /Sub-agent questions|Ask the user only/);
  });

  test('parseCli: interactive by default on a terminal without --quiet; --interactive and --no-interactive override', () => {
    const env = {};
    const interactive = (argv: string[], tty: boolean) => parseCli(['task', ...argv], env, tty).interactive;
    assert.equal(interactive([], true), true);
    assert.equal(interactive([], false), false, 'piped stdin: nobody at a terminal');
    assert.equal(interactive(['--quiet'], true), false);
    assert.equal(interactive(['-q'], true), false);
    assert.equal(interactive(['--no-interactive'], true), false);
    assert.equal(interactive(['--interactive'], false), true);
    assert.equal(interactive(['--interactive', '--quiet'], true), true);
    assert.equal(interactive(['--interactive', '--no-interactive'], true), false, '--no-interactive wins, like --no-vision');
  });

  test('parseCli: by default a terminal needs both stdin (to answer) and stdout (to see the question)', (t) => {
    const saved = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    t.after(() => {
      process.stdin.isTTY = saved.stdin as true;
      process.stdout.isTTY = saved.stdout as true;
    });
    const interactive = (stdin: boolean, stdout: boolean) => {
      process.stdin.isTTY = stdin as true;
      process.stdout.isTTY = stdout as true;
      return parseCli(['task'], {}).interactive;
    };
    assert.equal(interactive(true, true), true);
    assert.equal(interactive(true, false), false, 'output redirected to a file: the question would wait unseen');
    assert.equal(interactive(false, true), false, 'piped stdin: nobody to answer');
    assert.equal(interactive(false, false), false);
  });

  test('parseCli: task, options and environment defaults, and usage errors', () => {
    const cli = parseCli(
      ['Order', 'a mug', '--max-steps', '12', '--toolsets', 'core, agents', '--no-vision', '--json', 'out.json', '--reasoning', 'none'],
      { LMSTUDIO_MODEL: 'env/model', MCP_URL: 'http://127.0.0.1:9/mcp', AUTH_TOKEN: 't1', LM_API_TOKEN: 't2' },
      false,
    );
    assert.equal(cli.help, false);
    assert.equal(cli.json, 'out.json');
    assert.equal(cli.options.task, 'Order a mug');
    assert.equal(cli.options.model, 'env/model');
    assert.equal(cli.options.maxSteps, 12);
    assert.deepEqual(cli.options.toolsets, ['core', 'agents']);
    assert.equal(cli.options.vision, false);
    assert.equal(cli.options.reasoning, 'none');
    assert.equal(cli.options.mcpUrl, 'http://127.0.0.1:9/mcp');
    assert.equal(cli.options.authToken, 't1');
    assert.equal(cli.options.lmApiToken, 't2');
    assert.equal(cli.options.ask, undefined, 'main adds the ask callback');
    assert.equal(parseCli(['x', '--model', 'flag/model'], { LMSTUDIO_MODEL: 'env/model' }, false).options.model, 'flag/model');

    assert.equal(parseCli(['--help'], {}, true).help, true, 'help needs no task');
    const usage = (argv: string[]) => {
      try {
        parseCli(argv, {}, false);
      } catch (err) {
        assert.ok(err instanceof UsageError);
        return [err.message, err.showUsage];
      }
      assert.fail('expected a usage error');
    };
    assert.deepEqual(usage([]), ['Missing task.', true]);
    assert.deepEqual(usage(['x', '--reasoning', 'max']), ['--reasoning must be one of none, low, medium, high, on', false]);
    assert.deepEqual(usage(['x', '--max-steps', '0']), ['--max-steps must be a number >= 1, got "0"', false]);
    const [unknown, withUsage] = usage(['x', '--interactve'])!;
    assert.match(String(unknown), /Unknown option '--interactve'/);
    assert.equal(withUsage, true);
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
