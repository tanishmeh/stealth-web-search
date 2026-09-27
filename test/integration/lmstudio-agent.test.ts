import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgent, type AgentOptions, type AgentResult } from '../../scripts/lmstudio-agent.ts';
import { startFakeLlm, type FakeLlm, type FakeRequest, type FakeTurn } from '../helpers/fake-llm.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../helpers/harness.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The CLI agent loop against the real server, with a scripted stand-in for
 * LM Studio's OpenAI-compatible API (no model needed; real-model runs are
 * scripts/lmstudio-e2e.ts).
 */

type Reply =
  | { chunks: unknown[]; keepOpen?: boolean }
  | { status: number; body: unknown }
  | { hang: true; chunks?: unknown[] };

interface FakeLmStudio {
  url: string;
  requests: any[];
  script: (body: any, index: number) => Reply;
  models: unknown;
  openStreams: () => number;
  close: () => Promise<void>;
}

const MODEL = 'test/tool-model';

function modelList(opts: { loaded?: boolean; vision?: boolean; reasoning?: boolean; contextLength?: number } = {}) {
  return {
    models: [
      {
        type: 'llm',
        key: MODEL,
        loaded_instances: opts.loaded === false ? [] : [{ id: MODEL, config: { context_length: opts.contextLength ?? 32768 } }],
        capabilities: {
          vision: Boolean(opts.vision),
          trained_for_tool_use: true,
          ...(opts.reasoning === false ? {} : { reasoning: { allowed_options: ['off', 'low', 'medium', 'on'], default: 'on' } }),
        },
      },
    ],
  };
}

async function startFakeLmStudio(): Promise<FakeLmStudio> {
  const sockets = new Set<http.ServerResponse>();
  const fake: FakeLmStudio = {
    url: '',
    requests: [],
    script: () => ({ status: 500, body: { error: 'no script' } }),
    models: modelList(),
    openStreams: () => sockets.size,
    close: async () => {
      for (const res of sockets) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(fake.models));
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        return res.end();
      }
      const body = JSON.parse(raw);
      const index = fake.requests.length;
      fake.requests.push(body);
      const reply = fake.script(body, index);
      if ('status' in reply) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(reply.body));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sockets.add(res);
      res.on('close', () => sockets.delete(res));
      for (const chunk of reply.chunks ?? []) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if ('hang' in reply || reply.keepOpen) return;
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const choice = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } } };

function toolCall(name: string, args: string | object, id = String(Math.floor(Math.random() * 1e9))): Reply {
  const argText = typeof args === 'string' ? args : JSON.stringify(args);
  return {
    chunks: [
      choice({ role: 'assistant', reasoning_content: `I will call ${name}.` }),
      choice({ content: '\n\n' }),
      choice({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
      choice({ tool_calls: [{ index: 0, type: 'function', function: { arguments: argText } }] }),
      choice({}, 'tool_calls'),
      usage,
    ],
  };
}

function answer(text: string): Reply {
  return { chunks: [choice({ role: 'assistant', content: text }), choice({}, 'stop'), usage] };
}

function lastMessage(body: any): any {
  return body.messages[body.messages.length - 1];
}

function imageParts(body: any): number {
  return body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url').length;
}

describe('lmstudio agent loop (scripted model)', () => {
  let fx: FixtureServer;
  let srv: TestServer;
  let lms: FakeLmStudio;
  const output: string[] = [];

  const run = (task: string, extra: Partial<AgentOptions> = {}): Promise<AgentResult> =>
    runAgent({
      task,
      mcpUrl: srv.mcpUrl,
      authToken: process.env.AUTH_TOKEN,
      lmstudioUrl: lms.url,
      clientName: 'lmstudio-agent-test',
      color: false,
      write: (t) => output.push(t),
      ...extra,
    });

  before(async () => {
    fx = await startFixtureServer();
    srv = await startTestServer();
    lms = await startFakeLmStudio();
  });
  after(async () => {
    await lms?.close();
    await srv?.stop();
    await fx?.close();
  });

  test('runs tool calls on the server and returns the final answer', async () => {
    lms.requests = [];
    lms.models = modelList();
    lms.script = (_body, i) =>
      [toolCall('browser_navigate', { url: `${fx.baseUrl}/index.html` }, '1001'), toolCall('browser_snapshot', {}, '1002'), answer('The heading is "Hello Fixture" and Pear costs $2.')][i];

    const result = await run('Read the fixture page');
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.stopReason, 'final_answer');
    assert.match(result.finalAnswer ?? '', /Hello Fixture/);
    assert.deepEqual(result.toolCalls.map((c) => [c.name, c.executed, c.isError]), [
      ['browser_navigate', true, false],
      ['browser_snapshot', true, false],
    ]);
    assert.equal(result.model, MODEL);
    assert.equal(result.usage.promptTokens, 300);

    const first = lms.requests[0];
    assert.equal(first.model, MODEL);
    assert.equal(first.stream, true);
    assert.equal(first.reasoning_effort, 'low');
    assert.equal(first.messages[0].role, 'system');
    const nav = first.tools.find((t: any) => t.function.name === 'browser_navigate');
    assert.ok(nav, 'tools are offered as OpenAI functions');
    assert.equal(nav.function.parameters.type, 'object');
    assert.equal('$schema' in nav.function.parameters, false);

    const second = lms.requests[1];
    const assistant = second.messages[second.messages.length - 2];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.tool_calls[0].id, '1001');
    const toolMsg = lastMessage(second);
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, '1001');
    assert.match(toolMsg.content, /Fixture Home/);
    assert.match(lastMessage(lms.requests[2]).content, /Hello Fixture/);

    const state: any = await (await fetch(`${srv.baseUrl}/api/state`, { headers: process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {} })).json();
    const calls = state.history.activity.filter((a: any) => a.client === 'lmstudio-agent-test 1.0.0').map((a: any) => a.tool);
    assert.deepEqual(calls.slice(-2), ['browser_navigate', 'browser_snapshot']);
    assert.equal(state.sessions.some((s: any) => s.client === 'lmstudio-agent-test 1.0.0'), false, 'the agent ends its MCP session');
  });

  test('feeds invalid arguments, unknown tools and tool calls written as text back to the model', async () => {
    lms.requests = [];
    lms.script = (_body, i) =>
      [
        toolCall('browser_navigate', '{"url": ', '2001'),
        toolCall('browser_fly', {}, '2002'),
        answer('<tool_call>{"name": "browser_snapshot", "arguments": {}}</tool_call>'),
        answer('Done.'),
      ][i];
    const result = await run('Do something');
    assert.equal(result.stopReason, 'final_answer', result.error ?? '');
    assert.equal(result.finalAnswer, 'Done.');
    assert.deepEqual(result.toolCalls.map((c) => [c.name, c.executed]), [
      ['browser_navigate', false],
      ['browser_fly', false],
    ]);
    assert.match(lastMessage(lms.requests[1]).content, /not valid JSON/);
    assert.match(lastMessage(lms.requests[2]).content, /unknown tool "browser_fly"/);
    const nudge = lastMessage(lms.requests[3]);
    assert.equal(nudge.role, 'user');
    assert.match(nudge.content, /function-calling interface/);
  });

  test('gives up with an error when the model keeps writing tool calls as text', async () => {
    lms.requests = [];
    lms.models = modelList();
    lms.script = () => answer('browser_navigate({"url": "https://example.com"})');
    const result = await run('Open example.com');
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, 'error');
    assert.equal(result.finalAnswer, null);
    assert.match(result.error ?? '', /keeps writing tool calls as text/);
    assert.equal(lms.requests.length, 3, 'two nudges, then stop');
  });

  test('warns when the loaded context leaves no room for the conversation', async () => {
    lms.requests = [];
    lms.models = modelList({ contextLength: 16384 });
    lms.script = () => answer('ok');
    output.length = 0;
    const result = await run('hi');
    lms.models = modelList();
    assert.equal(result.ok, true, result.error ?? '');
    assert.match(output.join(''), /Warning: the model is loaded with a 16384-token context/);
  });

  test('sends screenshots as a user image message and keeps only the newest image', async () => {
    lms.requests = [];
    lms.models = modelList({ vision: true });
    lms.script = (_body, i) => [toolCall('browser_screenshot', {}), toolCall('browser_screenshot', {}), answer('It is white.')][i];
    const result = await run('Describe the page');
    assert.equal(result.ok, true, result.error ?? '');
    const afterFirst = lms.requests[1];
    const imageMsg = lastMessage(afterFirst);
    assert.equal(imageMsg.role, 'user');
    assert.match(imageMsg.content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(imageParts(afterFirst), 1);
    assert.equal(imageParts(lms.requests[2]), 1, 'older images are dropped');
    assert.equal(
      result.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')),
      false,
      'the returned transcript does not carry base64 images',
    );

    lms.requests = [];
    lms.script = (_body, i) => [toolCall('browser_screenshot', {}), answer('No image.')][i];
    const blind = await run('Describe the page', { vision: false });
    assert.equal(blind.ok, true, blind.error ?? '');
    assert.equal(imageParts(lms.requests[1]), 0);
    assert.match(lastMessage(lms.requests[1]).content, /vision is off/);
  });

  test('omits reasoning_effort for "on" and for models without reasoning options', async () => {
    lms.models = modelList();
    lms.requests = [];
    lms.script = () => answer('ok');
    assert.equal((await run('hi', { reasoning: 'on' })).ok, true);
    assert.equal('reasoning_effort' in lms.requests[0], false);

    lms.models = modelList({ reasoning: false });
    lms.requests = [];
    assert.equal((await run('hi', { reasoning: 'none' })).ok, true);
    assert.equal('reasoning_effort' in lms.requests[0], false);
    lms.models = modelList();
  });

  test('stops at the step limit with a best-effort answer requested without tools', async () => {
    lms.requests = [];
    lms.script = (_body, i) => [toolCall('browser_snapshot', { include_elements: false }), answer('Partial: Hello Fixture')][i];
    const result = await run('Loop forever', { maxSteps: 1 });
    assert.equal(result.stopReason, 'max_steps');
    assert.equal(result.finalAnswer, 'Partial: Hello Fixture');
    assert.equal(lms.requests.length, 2);
    assert.equal(lms.requests[1].tools, undefined);
  });

  test('explains when no tool-use model is loaded', async () => {
    lms.models = modelList({ loaded: false });
    lms.requests = [];
    const result = await run('hi');
    lms.models = modelList();
    assert.equal(result.stopReason, 'error');
    assert.match(result.error ?? '', /No loaded LM Studio model is trained for tool use/);
    assert.match(result.error ?? '', /lms load test\/tool-model/);
    assert.equal(lms.requests.length, 0);
  });

  test('an error event in the model stream ends the run instead of hanging', async () => {
    lms.requests = [];
    lms.script = () => ({ chunks: [choice({ reasoning_content: 'thinking' }), { error: { message: 'Model has crashed' } }], keepOpen: true });
    const started = Date.now();
    const result = await run('hi');
    assert.equal(result.stopReason, 'error');
    assert.match(result.error ?? '', /Model has crashed/);
    assert.ok(Date.now() - started < 20_000, 'finishes promptly');
  });

  test('aborting while the model is streaming ends the run and closes the request', async () => {
    lms.requests = [];
    lms.script = () => ({ hang: true, chunks: [choice({ reasoning_content: 'thinking...' })] });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);
    const result = await run('hi', { signal: controller.signal });
    assert.equal(result.stopReason, 'aborted');
    assert.ok(Date.now() - started < 10_000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lms.openStreams(), 0, 'the streaming request was closed');
  });

  test('Ctrl+C during a tool call makes the CLI exit promptly with code 130', async () => {
    let sigint: (() => void) | null = null;
    lms.requests = [];
    lms.script = (_body, i) => {
      if (i === 0) {
        setTimeout(() => sigint?.(), 1_500);
        return toolCall('browser_wait', { seconds: 4 });
      }
      return answer('should not be needed');
    };
    const child = spawn(process.execPath, ['scripts/lmstudio-agent.ts', 'wait a bit', '--quiet'], {
      cwd: ROOT,
      env: { ...process.env, MCP_URL: srv.mcpUrl, LMSTUDIO_URL: lms.url, LMSTUDIO_MODEL: MODEL, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    sigint = () => child.kill('SIGINT');
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 30_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 130, `exit code (stderr: ${stderr})`);
    assert.ok(Date.now() - started < 15_000, `exited ${Date.now() - started} ms after start`);
    // Let the server finish the queued wait before the next test uses the browser.
    await new Promise((r) => setTimeout(r, 3_000));
  });
});

/**
 * The CLI as an interactive host for sub-agent questions: a scripted host model starts a sub-agent
 * (a second scripted model, run by the server in its own browser) that asks before it orders on the
 * fixture checkout page. Needs a server started with the fake sub-agent model, so it is skipped
 * against MCP_URL.
 */
describe('lmstudio agent: the user approves a sub-agent purchase (scripted models)', { skip: process.env.MCP_URL ? 'needs a server started with the fake sub-agent model' : false }, () => {
  let fx: FixtureServer;
  let srv: TestServer;
  let lms: FakeLmStudio;
  let subAgent: FakeLlm;
  const output: string[] = [];
  const ORDER_QUESTION = 'Place the order for one Blue Mug, total $17.49, delivered to 1 Example Street, paid with the card ending 4242?';
  const ASKING = 'The shop is ready to order one Blue Mug for $17.49, delivered to 1 Example Street and paid with the card ending 4242. Would you like me to place this order? (Yes/No)';
  /** Orders the checkout fixture received (its form posts to /echo). */
  const orders = () => fx.requests.filter((r) => r.method === 'POST' && r.url === '/echo' && r.body.includes('item=blue-mug'));

  /** Every sub-agent run: open the checkout, ask the host, order only when the answer is yes. */
  const checkout = (req: FakeRequest): FakeTurn => {
    const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, arguments: args }] });
    switch (req.step) {
      case 1:
        return call('browser_navigate', { url: `${fx.baseUrl}/checkout.html` });
      case 2:
        return call('ask_host', { question: ORDER_QUESTION, options: ['Yes, place the order', 'No'], reason: 'confirm' });
      case 3:
        return /^The host answered: "Yes/.test(req.lastToolResult ?? '')
          ? call('browser_click', { selector: '#place' })
          : call('finish', { output: 'not ordered', success: false });
      default:
        return call('finish', { output: `ordered: ${req.lastToolResult}` });
    }
  };

  /** run_id and question_id from the waiting agent_run result in the host's conversation. */
  const waitingIds = (body: any): { run_id: string; question_id: string } => {
    const text = body.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join('\n');
    const m = /Run (r[0-9a-f]+) is waiting for your answer \(question (q[0-9a-f]+)/.exec(text);
    assert.ok(m, `a waiting result in the conversation: ${text.slice(0, 300)}`);
    return { run_id: m[1]!, question_id: m[2]! };
  };
  const startRun = (marker: string) => toolCall('agent_run', { task: `${marker}: order one Blue Mug from ${fx.baseUrl}/checkout.html`, output: 'the order confirmation' });

  const run = (task: string, extra: Partial<AgentOptions> = {}): Promise<AgentResult> =>
    runAgent({
      task,
      mcpUrl: srv.mcpUrl,
      authToken: process.env.AUTH_TOKEN,
      lmstudioUrl: lms.url,
      clientName: 'lmstudio-agent-approval-test',
      color: false,
      write: (t) => output.push(t),
      ...extra,
    });
  const agentStatus = async (runId: string) => (await srv.call('agent_status', { run_id: runId })).raw.structuredContent;

  before(async () => {
    fx = await startFixtureServer();
    subAgent = await startFakeLlm(checkout);
    srv = await startTestServer({
      AGENT_LLM_URL: subAgent.url,
      AGENT_LLM_MODEL: 'fake-model',
      AGENT_WAIT_SECONDS: '60',
      AGENT_REPLY_TIMEOUT_MS: '600000',
      SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-scripts-')),
    });
    lms = await startFakeLmStudio();
  });
  after(async () => {
    await lms?.close();
    await srv?.stop();
    await subAgent?.close();
    await fx?.close();
  });

  test('the host ends its turn to ask the user; the reply goes back to it, it answers with agent_reply and the order is placed', async () => {
    const before = orders().length;
    lms.requests = [];
    output.length = 0;
    lms.script = (body, i) => {
      switch (i) {
        case 0:
          return startRun('MARKER-CLI-YES');
        case 1:
          // the task did not approve the purchase: the host asks the user instead of answering
          return answer(ASKING);
        case 2:
          return toolCall('agent_reply', { ...waitingIds(body), answer: 'Yes, place the order' });
        default:
          return answer('Ordered one Blue Mug for $17.49.');
      }
    };
    const prompts: string[] = [];
    const result = await run('Order one Blue Mug from the shop', {
      ask: async (prompt) => {
        prompts.push(prompt);
        return '  Yes, place the order  ';
      },
    });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.finalAnswer, 'Ordered one Blue Mug for $17.49.');
    assert.deepEqual(result.toolCalls.map((c) => [c.name, c.isError]), [
      ['agent_run', false],
      ['agent_reply', false],
    ]);
    assert.equal(orders().length, before + 1, 'ordered once, after the user approved');

    // the host was told to ask the user, and got the reply as the next user message
    assert.match(lms.requests[0].messages[0].content, /end your turn by asking the user \(item, total, delivery address, payment method, the site\)/);
    assert.doesNotMatch(lms.requests[0].messages[0].content, /The user cannot answer/);
    const resumed = lms.requests[2].messages;
    assert.deepEqual(resumed.slice(-2), [
      { role: 'assistant', content: ASKING },
      { role: 'user', content: 'Yes, place the order' },
    ]);

    // the user saw the host's question and the sub-agent's, then the prompt
    assert.deepEqual(prompts, ['Your answer (Enter to leave it unanswered): ']);
    const { run_id, question_id } = waitingIds(lms.requests[2]);
    const origin = new URL(fx.baseUrl).origin;
    const printed = output.join('');
    assert.match(printed, /Question for you \(a sub-agent run waits for your answer\)\n/);
    assert.ok(printed.includes(`${ASKING}\n  run ${run_id} asks on ${origin}: ${ORDER_QUESTION}\n`), printed);
    assert.match(printed, /Final answer \(4 steps, 2 tool calls, /);

    // the transcript keeps the exchange
    assert.deepEqual(result.userTurns, [
      {
        step: 2,
        question: ASKING,
        waiting: [{ runId: run_id, questionId: question_id, text: ORDER_QUESTION, reason: 'confirm', origin, expiresAt: result.userTurns[0]!.waiting[0]!.expiresAt }],
        reply: 'Yes, place the order',
      },
    ]);
    assert.deepEqual(result.waitingRuns, []);
    assert.ok(result.messages.some((m) => m.role === 'user' && m.content === 'Yes, place the order'));

    const s = await agentStatus(run_id);
    assert.equal(s.status, 'completed');
    assert.match(s.output, /^ordered: Clicked button\[submit\] "Place your order"/);
    assert.deepEqual(s.questions.map((q: any) => [q.reason, q.status, q.answer]), [['confirm', 'answered', 'Yes, place the order']]);
  });

  test('no reply: the run ends as before, the sub-agent run keeps waiting and nothing is ordered', async () => {
    const before = orders().length;
    lms.requests = [];
    output.length = 0;
    lms.script = (_body, i) => [startRun('MARKER-CLI-NONE'), answer(ASKING)][i] ?? answer('should not be needed');
    let asked = 0;
    const result = await run('Order one Blue Mug from the shop', {
      ask: async () => {
        asked++;
        return '';
      },
    });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.stopReason, 'final_answer');
    assert.equal(result.finalAnswer, ASKING);
    assert.equal(asked, 1);
    assert.equal(lms.requests.length, 2, 'the model is not called again');
    const { run_id, question_id } = waitingIds(lms.requests[1]);
    assert.deepEqual(result.userTurns.map((t) => [t.step, t.reply, t.waiting.map((w) => w.runId)]), [[2, null, [run_id]]]);
    assert.deepEqual(result.waitingRuns.map((w) => [w.runId, w.questionId, w.reason]), [[run_id, question_id, 'confirm']]);
    const printed = output.join('');
    assert.match(printed, /No answer; stopping \(2 steps, 1 tool calls, /);
    assert.doesNotMatch(printed, /Final answer/, 'the question is not printed twice');
    assert.match(
      printed,
      new RegExp(`Run ${run_id} is still waiting for an answer to question ${question_id}\\. Unanswered, it continues without it after its timeout \\(in about 10 min\\) and does not take the step it asked about, so nothing is ordered\\.`),
    );

    assert.equal((await agentStatus(run_id)).status, 'waiting');
    assert.equal(orders().length, before, 'nothing was ordered');
    await srv.call('agent_cancel', { run_id });
    assert.equal(orders().length, before);
  });

  test('without an ask callback, or with no step left, the user is not asked and the waiting run is reported', async () => {
    const before = orders().length;
    const runIds: string[] = [];
    for (const extra of [{}, { maxSteps: 2, ask: async () => assert.fail('no step left to pass on an answer') }] as Array<Partial<AgentOptions>>) {
      lms.requests = [];
      output.length = 0;
      lms.script = (_body, i) => [startRun('MARKER-CLI-QUIET'), answer(ASKING)][i] ?? answer('should not be needed');
      const result = await run('Order one Blue Mug from the shop', extra);
      assert.equal(result.stopReason, 'final_answer', result.error ?? '');
      assert.equal(lms.requests.length, 2);
      const { run_id } = waitingIds(lms.requests[1]);
      runIds.push(run_id);
      assert.deepEqual(result.userTurns, []);
      assert.deepEqual(result.waitingRuns.map((w) => w.runId), [run_id]);
      const printed = output.join('');
      assert.match(printed, /Final answer \(2 steps, 1 tool calls, /);
      assert.match(printed, new RegExp(`Run ${run_id} is still waiting for an answer`));
      if (extra.ask) {
        assert.match(printed, /No steps left to ask you and pass on your answer \(--max-steps 2\)\./);
        assert.match(lms.requests[0].messages[0].content, /end your turn by asking the user/);
      } else {
        // one-shot: the host is told nobody can answer, and to refuse what the task did not approve
        assert.match(lms.requests[0].messages[0].content, /The user cannot answer questions while you work\./);
        assert.match(lms.requests[0].messages[0].content, /reply "No" to the confirm question, and say in your final answer that the order is ready/);
      }
    }
    for (const run_id of runIds) await srv.call('agent_cancel', { run_id });
    assert.equal(orders().length, before);
  });

  test('a run that ends in an error still reports the sub-agent run left waiting', async () => {
    const before = orders().length;
    lms.requests = [];
    output.length = 0;
    // the model starts a run, then only returns empty replies: two nudges, then the run ends in an error
    lms.script = (_body, i) => (i === 0 ? startRun('MARKER-CLI-EMPTY') : answer(''));
    const result = await run('Order one Blue Mug from the shop', { ask: async () => assert.fail('nothing to ask: the model asked nothing') });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error, 'The model returned an empty response.', output.join(''));
    assert.equal(lms.requests.length, 4);
    const { run_id, question_id } = waitingIds(lms.requests[1]);
    assert.deepEqual(result.waitingRuns.map((w) => [w.runId, w.questionId, w.reason]), [[run_id, question_id, 'confirm']]);
    assert.match(output.join(''), new RegExp(`Run ${run_id} is still waiting for an answer to question ${question_id}\\..*so nothing is ordered\\.`));
    await srv.call('agent_cancel', { run_id });
    assert.equal(orders().length, before);
  });

  test('a lost MCP connection while checking for waiting runs does not replace the final answer', async () => {
    // a TCP proxy in front of the server, cut before the model's final answer, as when the server goes away
    const target = new URL(srv.mcpUrl);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port), target.hostname);
      sockets.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const cut = () => {
      proxy.close();
      for (const s of sockets) s.destroy();
    };
    const viaProxy = new URL(srv.mcpUrl);
    viaProxy.host = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    let runId = '';
    try {
      lms.requests = [];
      output.length = 0;
      lms.script = (body, i) => {
        if (i === 0) return startRun('MARKER-CLI-LOST');
        runId = waitingIds(body).run_id;
        cut();
        return answer(ASKING);
      };
      const result = await run('Order one Blue Mug from the shop', { mcpUrl: viaProxy.toString(), ask: async () => assert.fail('no waiting run is known') });
      assert.equal(result.stopReason, 'final_answer', result.error ?? '');
      assert.equal(result.finalAnswer, ASKING);
      assert.deepEqual(result.waitingRuns, []);
    } finally {
      cut();
      if (runId) await srv.call('agent_cancel', { run_id: runId });
    }
  });

  /** Run the CLI with piped stdin that stays open (the answers wait in the pipe until it asks); resolves with its exit code, null if it hangs. */
  const cli = async (args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const child = spawn(process.execPath, ['scripts/lmstudio-agent.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, MCP_URL: srv.mcpUrl, LMSTUDIO_URL: lms.url, LMSTUDIO_MODEL: MODEL, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => undefined);
    child.stdin.write(input);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 90_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    return { code, stdout, stderr };
  };

  test('the CLI with piped stdin and no --interactive never reads it: it reports the waiting run and exits', async () => {
    const before = orders().length;
    lms.requests = [];
    lms.script = (_body, i) => [startRun('MARKER-CLI-PIPED'), answer(ASKING)][i] ?? answer('should not be needed');
    const json = path.join(mkdtempSync(path.join(tmpdir(), 'sbm-cli-')), 'run.json');
    const { code, stdout, stderr } = await cli(['Order one Blue Mug from the shop', '--json', json], 'yes\n');
    assert.equal(code, 0, `exit code (stderr: ${stderr})\n${stdout}`);
    assert.equal(lms.requests.length, 2, 'the model is not called again');
    assert.match(lms.requests[0].messages[0].content, /The user cannot answer questions while you work\./);
    assert.doesNotMatch(stdout, /Question for you|Your answer/);
    assert.match(stdout, /Final answer \(2 steps, 1 tool calls, /);
    const transcript = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(transcript.options.interactive, false);
    assert.deepEqual(transcript.userTurns, []);
    assert.equal(transcript.waitingRuns.length, 1);
    const { runId: run_id } = transcript.waitingRuns[0];
    assert.match(stdout, new RegExp(`Run ${run_id} is still waiting for an answer`));
    await srv.call('agent_cancel', { run_id });
    assert.equal(orders().length, before);
  });

  test('the CLI asks on stdin with --interactive and writes the exchange to the --json transcript', async () => {
    const before = orders().length;
    lms.requests = [];
    lms.script = (body, i) => [() => startRun('MARKER-CLI-STDIN'), () => answer(ASKING), () => toolCall('agent_reply', { ...waitingIds(body), answer: 'Yes' }), () => answer('Ordered.')][i]?.() ?? answer('done');
    const json = path.join(mkdtempSync(path.join(tmpdir(), 'sbm-cli-')), 'run.json');
    // stdin stays open after the answer: the CLI still exits once the run is done
    const { code, stdout, stderr } = await cli(['Order one Blue Mug from the shop', '--interactive', '--json', json], 'yes please\n');
    assert.equal(code, 0, `exit code (stderr: ${stderr})\n${stdout}`);
    assert.match(stdout, /Question for you \(a sub-agent run waits for your answer\)\n/);
    // the piped answer is not echoed: the prompt line still ends, as it does after Enter in a terminal
    assert.match(stdout, /Your answer \(Enter to leave it unanswered\): \n\n\[step 3\]/);
    assert.match(stdout, /Final answer \(4 steps, 2 tool calls, [^)]*\)\nOrdered\.\n/);
    assert.deepEqual(lms.requests[2].messages.at(-1), { role: 'user', content: 'yes please' });
    const transcript = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(transcript.options.interactive, true);
    assert.equal(transcript.userTurns[0].reply, 'yes please');
    assert.equal(transcript.userTurns[0].waiting[0].reason, 'confirm');
    assert.deepEqual(transcript.waitingRuns, []);
    assert.equal(orders().length, before + 1);
  });
});
