import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgent, type AgentOptions, type AgentResult } from '../../scripts/lmstudio-agent.ts';
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
