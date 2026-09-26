import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pino from 'pino';
import { TokenMeter, compactTranscript, parseToolArguments, transcriptChars } from '../../src/agents/conversation.ts';
import { isSearchResultsPage, quoteFound, quoteMatch, siteOf } from '../../src/agents/kinds.ts';
import { redactParams } from '../../src/mcp/server.ts';
import { evaluationSource, isExpression } from '../../src/scripts/api.ts';
import { ChatClient, LlmError, splitThinking, type ChatMessage } from '../../src/agents/llm.ts';
import { decodeResultUrl } from '../../src/agents/search.ts';
import { chatCompletionsUrl, loadConfig } from '../../src/config.ts';
import { Hub, type HubEvent } from '../../src/dashboard/hub.ts';
import { LogTap } from '../../src/logger.ts';
import { startFakeLlm, type FakeLlm } from '../helpers/fake-llm.ts';

const silent = pino({ level: 'silent' });

describe('agent configuration', () => {
  test('chat completions URL accepts a base URL, a /v1 URL or the full endpoint', () => {
    assert.equal(chatCompletionsUrl('http://10.0.0.5:8000'), 'http://10.0.0.5:8000/v1/chat/completions');
    assert.equal(chatCompletionsUrl('http://10.0.0.5:8000/v1'), 'http://10.0.0.5:8000/v1/chat/completions');
    assert.equal(chatCompletionsUrl('http://10.0.0.5:8000/v1/'), 'http://10.0.0.5:8000/v1/chat/completions');
    assert.equal(chatCompletionsUrl('http://10.0.0.5:8000/v1/chat/completions'), 'http://10.0.0.5:8000/v1/chat/completions');
    assert.equal(chatCompletionsUrl('https://api.example.com/openai/v2'), 'https://api.example.com/openai/v2/chat/completions');
    assert.throws(() => chatCompletionsUrl('ftp://x'), /http\(s\) URL/);
    assert.throws(() => chatCompletionsUrl('not a url'), /http\(s\) URL/);
  });

  test('agents are off without AGENT_LLM_URL; the defaults match a 64k context', () => {
    const off = loadConfig({});
    assert.equal(off.agent.enabled, false);
    const on = loadConfig({ AGENT_LLM_URL: 'http://192.168.1.50:8000/v1/chat/completions', AGENT_LLM_MODEL: 'qwen3.8-27b', AGENT_LLM_API_KEY: 'test-key' });
    assert.equal(on.agent.enabled, true);
    assert.equal(on.agent.endpoint, 'http://192.168.1.50:8000/v1/chat/completions');
    assert.equal(on.agent.contextTokens, 65_536);
    assert.equal(on.agent.temperature, 0.4);
    assert.equal(on.agent.topP, 0.95);
    assert.equal(on.agent.reasoningEffort, 'medium');
    assert.equal(on.agent.thinking, null);
    assert.equal(on.agent.streaming, true);
    assert.equal(loadConfig({ AGENT_LLM_URL: 'http://x:1', AGENT_LLM_REASONING_EFFORT: 'none' }).agent.reasoningEffort, null);
    assert.equal(loadConfig({ AGENT_LLM_URL: 'http://x:1', AGENT_LLM_THINKING: 'false' }).agent.thinking, false);
  });

  test('invalid agent settings stop startup with the variable name', () => {
    assert.throws(() => loadConfig({ AGENT_LLM_URL: 'x' }), /AGENT_LLM_URL/);
    assert.throws(() => loadConfig({ AGENT_LLM_URL: 'http://x:1', AGENT_LLM_EXTRA_BODY: '[1]' }), /AGENT_LLM_EXTRA_BODY/);
    assert.throws(() => loadConfig({ AGENT_LLM_URL: 'http://x:1', AGENT_LLM_TEMPERATURE: '3' }), /AGENT_LLM_TEMPERATURE/);
    assert.throws(() => loadConfig({ AGENT_CONTEXT_TOKENS: '16384', AGENT_MAX_OUTPUT_TOKENS: '9000' }), /AGENT_MAX_OUTPUT_TOKENS/);
    assert.throws(() => loadConfig({ AGENT_SEARCH_ENGINE: 'google' }), /AGENT_SEARCH_ENGINE/);
    assert.throws(() => loadConfig({ AGENT_LLM_THINKING: 'maybe' }), /AGENT_LLM_THINKING/);
  });
});

describe('agent conversation helpers', () => {
  test('tool arguments: JSON, fenced JSON, junk around an object, empty', () => {
    assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseToolArguments('sure: {"a":1} done'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseToolArguments(''), { ok: true, value: {} });
    assert.equal(parseToolArguments('[1,2]').ok, false);
    assert.equal(parseToolArguments('{"a":').ok, false);
  });

  test('<think> blocks are split from the answer', () => {
    assert.deepEqual(splitThinking('<think>plan</think>answer'), { reasoning: 'plan', content: 'answer' });
    assert.deepEqual(splitThinking('plan only</think>\nanswer'), { reasoning: 'plan only', content: 'answer' });
  });

  test('the token meter follows the measured characters per token and stays conservative', () => {
    const m = new TokenMeter();
    assert.equal(m.charsPerToken, 3);
    m.observe(40_000, 10_000); // 4 chars/token measured
    assert.equal(m.charsPerToken, 3.5, 'a higher ratio is only trusted halfway');
    m.observe(20_000, 10_000); // 2 chars/token
    assert.equal(m.charsPerToken, 2);
    m.observe(100, 10); // too small to measure
    assert.equal(m.charsPerToken, 2);
  });

  function transcript(steps: number, resultChars: number): ChatMessage[] {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'TASK: do it' },
    ];
    for (let i = 1; i <= steps; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}a`, type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }, { id: `c${i}b`, type: 'function', function: { name: 'note', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: `c${i}a`, content: `result ${i} `.repeat(resultChars / 10) });
      msgs.push({ role: 'tool', tool_call_id: `c${i}b`, content: 'Noted.' });
    }
    return msgs;
  }

  function assertPairsIntact(msgs: ChatMessage[]): void {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'tool') continue;
      let j = i - 1;
      while (j >= 0 && msgs[j].role === 'tool') j--;
      assert.equal(msgs[j].role, 'assistant', `tool message ${i} follows an assistant turn`);
      assert.ok(msgs[j].tool_calls?.some((c) => c.id === m.tool_call_id), `tool message ${i} answers a call of that turn`);
    }
  }

  test('compaction shortens old results first and keeps the newest ones whole', () => {
    const msgs = transcript(8, 5_000);
    const before = transcriptChars(msgs);
    const report = compactTranscript(msgs, before - 25_000, () => '');
    assert.ok(report.shortened > 0);
    assert.equal(report.droppedSteps, 0);
    assert.ok(transcriptChars(msgs) <= before - 25_000);
    assert.ok(String(msgs.at(-2)!.content).length >= 4_500, 'the newest result stays whole');
    assert.match(String(msgs[3].content), /older result shortened/);
    assertPairsIntact(msgs);
  });

  test('compaction drops whole old steps when shortening is not enough, keeping the task and notes', () => {
    const msgs = transcript(30, 2_000);
    const report = compactTranscript(msgs, 8_000, () => '1. price is $5');
    assert.ok(report.droppedSteps > 0);
    assert.ok(transcriptChars(msgs) <= 8_000 || msgs.filter((m) => m.role === 'assistant').length === 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].content, 'TASK: do it');
    const note = msgs.find((m) => m.role === 'user' && m.content?.startsWith('[Context note]'))!;
    assert.match(note.content!, /earlier step\(s\) were removed/);
    assert.match(note.content!, /price is \$5/);
    assertPairsIntact(msgs);
    // a second compaction merges into one note and counts all dropped steps
    msgs.push(...transcript(10, 2_000).slice(2));
    compactTranscript(msgs, 8_000, () => '1. price is $5');
    const notes = msgs.filter((m) => m.role === 'user' && m.content?.startsWith('[Context note]'));
    assert.equal(notes.length, 1);
    assert.ok(Number(/(\d+) earlier step/.exec(notes[0].content!)![1]) > report.droppedSteps);
    assertPairsIntact(msgs);
  });
});

describe('finder helpers', () => {
  test('quotes are found despite case, whitespace, curly quotes and Markdown markup', () => {
    const page = '# About\n\nProject **Zephyr** was  first released\nin 2019 by the “Aurora Foundation”.';
    assert.ok(quoteFound('project zephyr was first released in 2019', page));
    assert.ok(quoteFound('by the "Aurora Foundation"', page));
    assert.ok(!quoteFound('released in 2021', page));
    assert.ok(!quoteFound('', page));
    const long = 'The quick brown fox jumps over the lazy dog while the cat watches from the old wooden fence near the river bank today';
    assert.equal(quoteMatch(long.replace('while the cat watches', 'as a cat watches'), long), 'partial', 'a long quote with a small change only partly matches');
    assert.equal(quoteFound(long.replace('while the cat watches', 'as a cat watches'), long), false, 'and does not count as verified');
    // quotes copied from browser_markdown keep the link text only
    assert.ok(quoteFound('See the [release notes](https://example.com/notes) for 2019.', 'See the release notes for 2019.'));
    // no match inside a longer word or number
    assert.ok(!quoteFound('released in 201', 'It was released in 2019.'));
    assert.ok(!quoteFound('cat', 'the category page'));
  });

  test('long quotes may drop a clause but never change a number', () => {
    const page = 'The Aurora Foundation first released Project Zephyr in 2019 after three years of private development by a team of volunteers.';
    assert.equal(quoteMatch('The Aurora Foundation first released Project Zephyr in 2019 after three years of development by a team of volunteers.', page), 'partial');
    assert.equal(quoteMatch(page, page), 'exact');
    assert.equal(quoteMatch('The Aurora Foundation first released Project Zephyr in 2021 after three years of private development by a team of volunteers.', page), null);
    assert.equal(quoteMatch('by a team of volunteers after three years of private development The Aurora Foundation first released Project Zephyr in 2019', page), null, 'pieces must be in order');
  });

  test('numbers must match whole, Markdown emphasis is ignored, and scripts without spaces still match', () => {
    assert.ok(!quoteFound('The population was 8,336', 'The population was 8,336,817 in 2020'));
    assert.ok(!quoteFound('costs 12', 'it costs 12.99 now'));
    assert.ok(!quoteFound('version 3.5', 'version 3.5.1 is out'));
    assert.ok(quoteFound('version 3.5.', 'use version 3.5. It works'));
    assert.ok(quoteFound('**Zephyr**, the project', 'Zephyr, the project'));
    assert.ok(quoteFound('the `run()` function', 'the run() function'));
    assert.ok(quoteFound('东京是日本的首都', '我们知道东京是日本的首都。'));
  });

  test('only search engine result pages are refused as sources', () => {
    assert.equal(isSearchResultsPage('https://www.google.com/search?q=x'), true);
    assert.equal(isSearchResultsPage('https://www.google.co.uk/url?q=x'), true);
    assert.equal(isSearchResultsPage('https://html.duckduckgo.com/html/?q=a'), true);
    assert.equal(isSearchResultsPage('https://www.bing.com/search?q=a'), true);
    assert.equal(isSearchResultsPage('https://docs.google.com/document/d/1'), false);
    assert.equal(isSearchResultsPage('https://yandex.ru/maps'), false);
    assert.equal(isSearchResultsPage('https://duckduckgo.com/about'), false);
    assert.equal(isSearchResultsPage('not a url'), false);
  });

  test('sources are grouped by website (registrable domain)', () => {
    assert.equal(siteOf('https://en.wikipedia.org/wiki/X'), 'wikipedia.org');
    assert.equal(siteOf('https://de.m.wikipedia.org/wiki/X'), 'wikipedia.org');
    assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
    assert.equal(siteOf('http://127.0.0.1:8080/a'), '127.0.0.1');
    assert.equal(siteOf('http://localhost:3000/'), 'localhost');
  });

  test('password-like script parameters are masked for logs', () => {
    assert.deepEqual(redactParams({ user: 'bob', password: 'hunter2', api_token: 'x', pin: '', limit: 3 }), { user: 'bob', password: '[REDACTED]', api_token: '[REDACTED]', pin: '', limit: 3 });
  });

  test('script evaluate returns the value of expressions, statements and function bodies', async () => {
    const vm = await import('node:vm');
    const run = async (code: string) => {
      const ctx: any = vm.createContext({ document: { title: 'T' }, JSON });
      ctx.globalThis = ctx;
      return vm.runInContext(evaluationSource(code), ctx);
    };
    const cases: Array<[string, unknown]> = [
      ['document.title', 'T'],
      ['document.title;', 'T'],
      ['const x = document.title; x', 'T'],
      ['let a = 1;\n a + 1;', 2],
      ['if (true) { 7 }', 7],
      ['const a = 2; return a * 3', 6],
      ['await Promise.resolve(5)', 5],
      ['const v = await Promise.resolve(4); v * 2', 8],
      ['"a return b"', 'a return b'],
      ['const v = await (Promise.resolve(3)); v', 3],
      ['const r = await (async () => 5)(); r', 5],
      // `await` only in a comment, string or regex literal: plain statements keep their completion value
      ['// no need to await\nif (document.title) { "yes" } else { "no" }', 'yes'],
      ['try { document.title } catch (e) { "await" }', 'T'],
      ['if (/await/.test("t")) { "a" } else { "b" }', 'b'],
      // a real await after a regex literal that contains quotes or slashes
      [String.raw`const q = document.title.replace(/['"]/g, ''); const r = await (Promise.resolve(q)); r`, 'T'],
      [String.raw`const u = 'http://x'.replace(/^https?:\/\//, ''); const r = await (Promise.resolve(u)); r`, 'x'],
      ['const s = `a ${await (Promise.resolve(2))} b`; s', 'a 2 b'],
      // code a lexical heuristic would misread: the parser decides
      ['let i = 4; const q = i++ / 2; const r = await (Promise.resolve(q)); r', 2],
      ['const counts = {new: 6, all: 3}; const pct = counts.new / counts.all; const r = await (Promise.resolve(pct)); r', 2],
      ['const q = document.title.replace(/* c */ /`/g, "");\nconst r = await (Promise.resolve(q));\nr', 'T'],
      ['// first line\rconst r = await (Promise.resolve(1)); r', 1],
      ['const x = { await: 5 }; x.await', 5],
      // a `;` in a trailing comment is not a statement boundary
      ['const r = await (Promise.resolve(3));\nr // then; done', 3],
      // nor is a line break the next line continues (call, tagged template); `++` starts a new statement
      ['const g = (a) => (b) => a + b;\nawait g(1)\n(2)', 3],
      ["const tag = (s) => s[0] + '!'; const f = async () => tag; (await f())\n`hi`", 'hi!'],
      ['let n = 1; await (Promise.resolve())\n++n', 2],
    ];
    for (const [code, expected] of cases) assert.equal(JSON.parse(await run(code)), expected, code);
  });

  test('deciding how to run evaluate code stays fast on pathological input', () => {
    for (const big of ['/* '.repeat(200_000), "'\\".repeat(80_000), '`'.repeat(100_001), '/'.repeat(300_000), '`${'.repeat(6_000), '(' + 'a;'.repeat(24_000)]) {
      const t0 = Date.now();
      evaluationSource(big);
      assert.ok(Date.now() - t0 < 1_000, `${big.slice(0, 4)}… took ${Date.now() - t0} ms`);
    }
  });

  test('script evaluate tells expressions from statement bodies without running them', () => {
    assert.equal(isExpression('document.title'), true);
    assert.equal(isExpression('({a: 1})'), true);
    assert.equal(isExpression('await fetch("/x").then(r => r.json())'), true);
    assert.equal(isExpression('const a = 1; return a'), false);
    assert.equal(isExpression('window.__n = (window.__n || 0) + 1; return window.__n'), false);
  });

  test('search result links are decoded to their destination', () => {
    assert.equal(
      decodeResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fh4ckf0r0day%2Fobscura&rut=abc'),
      'https://github.com/h4ckf0r0day/obscura',
    );
    const b64 = Buffer.from('https://example.org/page?x=1').toString('base64url');
    assert.equal(decodeResultUrl(`https://www.bing.com/ck/a?!&&p=1&u=a1${b64}&ntb=1`), 'https://example.org/page?x=1');
    assert.equal(decodeResultUrl('https://www.bing.com/search?q=next'), null, 'engine-internal links are dropped');
    assert.equal(decodeResultUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(decodeResultUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), null);
  });
});

describe('model client', () => {
  let llm: FakeLlm;
  const baseConfig = (url: string, extra: Record<string, string> = {}) =>
    loadConfig({ AGENT_LLM_URL: url, AGENT_LLM_API_KEY: 'k', AGENT_LLM_MODEL: 'fake-model', AGENT_LLM_TIMEOUT_MS: '5000', ...extra }).agent;

  before(async () => {
    llm = await startFakeLlm(() => ({ content: 'hello' }));
  });
  after(async () => {
    await llm.close();
  });

  test('lists models at /models next to the endpoint, keeping a query such as api-version', async () => {
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm-1' }] }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const client = new ChatClient(baseConfig(`http://127.0.0.1:${port}/v1?api-version=2024-10-21`), pino({ level: 'silent' }));
      assert.deepEqual(await client.listModels(5_000), ['m-1']);
      const plain = new ChatClient(baseConfig(`http://127.0.0.1:${port}/v1`), pino({ level: 'silent' }));
      assert.deepEqual(await plain.listModels(5_000), ['m-1']);
      assert.deepEqual(seen, ['/v1/models?api-version=2024-10-21', '/v1/models']);
    } finally {
      srv.close();
    }
  });

  test('streams reasoning, content and tool calls whose arguments arrive in pieces', async () => {
    llm.setPolicy(() => ({
      reasoning: 'I should look at the page first.',
      content: 'Checking.',
      toolCalls: [
        { name: 'browser_navigate', arguments: { url: 'https://example.com/a-long-path?with=query&and=more' } },
        { name: 'note', arguments: { text: 'second call' } },
      ],
    }));
    const client = new ChatClient(baseConfig(llm.url), silent);
    const deltas: string[] = [];
    const out = await client.complete({ messages: [{ role: 'user', content: 'go' }], onDelta: (k, t) => deltas.push(`${k}:${t}`) });
    assert.equal(out.reasoning, 'I should look at the page first.');
    assert.equal(out.content, 'Checking.');
    assert.equal(out.toolCalls.length, 2);
    assert.deepEqual(JSON.parse(out.toolCalls[0].arguments), { url: 'https://example.com/a-long-path?with=query&and=more' });
    assert.equal(out.toolCalls[1].name, 'note');
    assert.equal(out.finishReason, 'tool_calls');
    assert.equal(out.usage?.completionTokens, 42);
    assert.ok(deltas.some((d) => d.startsWith('reasoning:')));
    const body = llm.requests.at(-1)!.body;
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.max_tokens, 8192);
    assert.equal(llm.requests.at(-1)!.headers.authorization, 'Bearer k');
  });

  test('non-streaming mode, extra body fields and thinking toggle', async () => {
    llm.setPolicy(() => ({ reasoning: 'r', toolCalls: [{ name: 'finish', arguments: { output: 'x' } }] }));
    const client = new ChatClient(baseConfig(llm.url, { AGENT_LLM_STREAMING: 'false', AGENT_LLM_EXTRA_BODY: '{"top_k":20}', AGENT_LLM_THINKING: 'false' }), silent);
    const out = await client.complete({ messages: [{ role: 'user', content: 'go' }], tools: [], toolChoice: 'auto' });
    assert.equal(out.toolCalls[0].name, 'finish');
    assert.equal(out.reasoning, 'r');
    const body = llm.requests.at(-1)!.body;
    assert.equal(body.stream, undefined);
    assert.equal(body.top_k, 20);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  });

  test('transient errors are retried; auth errors are not; context overflow is recognised', async () => {
    let calls = 0;
    llm.setPolicy(() => (++calls === 1 ? { status: 503, error: 'busy' } : { content: 'ok' }));
    const client = new ChatClient(baseConfig(llm.url), silent);
    const out = await client.complete({ messages: [{ role: 'user', content: 'go' }] });
    assert.equal(out.content, 'ok');
    assert.equal(calls, 2);

    llm.setPolicy(() => ({ status: 401, error: 'bad key' }));
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'go' }] }), (err: LlmError) => {
      assert.equal(err.transient, false);
      assert.match(err.message, /rejected the API key \(HTTP 401\)/);
      return true;
    });

    llm.setPolicy(() => ({ status: 400, error: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens" }));
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'go' }] }), (err: LlmError) => err.contextOverflow === true);
  });

  test('an unreachable endpoint and a silent endpoint fail with clear messages', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const client = new ChatClient(baseConfig(`http://127.0.0.1:${port}/v1`), silent);
    await assert.rejects(client.listModels(2_000), /cannot reach the model endpoint/);

    const silentServer = http.createServer(() => undefined); // never answers
    await new Promise<void>((r) => silentServer.listen(0, '127.0.0.1', r));
    const sport = (silentServer.address() as AddressInfo).port;
    try {
      const c2 = new ChatClient(baseConfig(`http://127.0.0.1:${sport}/v1`), silent);
      await assert.rejects(c2.listModels(300), /sent nothing for/);
    } finally {
      silentServer.closeAllConnections();
      silentServer.close();
    }
  });

  test('the model id defaults to the first model the endpoint lists', async () => {
    const cfg = loadConfig({ AGENT_LLM_URL: llm.url }).agent;
    const client = new ChatClient(cfg, silent);
    assert.equal(await client.model(), 'fake-model');
  });

  test('an abort signal cancels a slow request', async () => {
    llm.setPolicy(() => ({ content: 'late', delayMs: 3_000 }));
    const client = new ChatClient(baseConfig(llm.url), silent);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'go' }], signal: ac.signal }), /cancelled/);
    assert.ok(Date.now() - t0 < 2_000);
  });
});

describe('dashboard hub with several browsers', () => {
  test('browser events reach only viewers of that browser; agent events reach everyone', () => {
    const hub = new Hub(new LogTap());
    const mainEvents: HubEvent[] = [];
    const agentEvents: HubEvent[] = [];
    hub.subscribe((e) => mainEvents.push(e), true);
    hub.subscribe((e) => agentEvents.push(e), true, 'agent-r1');
    const agent = hub.channel('agent-r1');
    const main = hub.channel('main');
    const frame = { tabId: 'tab-1', url: 'u', title: 't', at: '', width: 1, height: 1, scrollX: 0, scrollY: 0, mimeType: 'image/jpeg' as const, data: 'x' };
    agent.publishFrame(frame);
    agent.publishConsole({ tabId: 'tab-1', level: 'log', text: 'from agent', at: '' });
    main.publishConsole({ tabId: 'tab-1', level: 'log', text: 'from main', at: '' });
    agent.publishTabs({ tabs: [], activeTabId: null });
    hub.publishAgent({ id: 'r1', kind: 'task', status: 'running' });
    assert.deepEqual(mainEvents.map((e) => e.type), ['console', 'agent']);
    assert.equal((mainEvents[0].data as any).text, 'from main');
    assert.deepEqual(agentEvents.map((e) => e.type), ['frame', 'console', 'tabs', 'agent']);
    assert.equal((agentEvents[0].data as any).browserId, 'agent-r1');
    assert.equal(hub.latestFrame, null, 'the main browser has no frame');
    assert.equal(hub.latestFrameFor('agent-r1')?.browserId, 'agent-r1');
    assert.equal(hub.viewerCountFor('main'), 1);
    assert.equal(hub.viewerCountFor('agent-r1'), 1);
    assert.equal(hub.viewerCount, 2);
    assert.deepEqual(hub.history('agent-r1').console.map((c) => c.text), ['from agent']);
    assert.deepEqual(hub.history().console.map((c) => c.text), ['from main']);
    assert.equal(hub.history().agents.length, 1);
  });

  test('a channel only hears about its own viewers', () => {
    const hub = new Hub(new LogTap());
    const seen: number[] = [];
    const off = hub.channel('agent-r2').onViewers((n) => seen.push(n));
    const unsubMain = hub.subscribe(() => undefined, true);
    const unsubAgent = hub.subscribe(() => undefined, true, 'agent-r2');
    unsubAgent();
    unsubMain();
    off();
    hub.subscribe(() => undefined, true, 'agent-r2');
    assert.deepEqual(seen, [1, 0]);
  });
});
