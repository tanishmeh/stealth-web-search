import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pino from 'pino';
import { TokenMeter, compactTranscript, parseToolArguments, transcriptChars } from '../../src/agents/conversation.ts';
import { runResult } from '../../src/agents/format.ts';
import { isSearchResultsPage, quoteFound, quoteMatch, siteOf } from '../../src/agents/kinds.ts';
import { redactParams } from '../../src/mcp/server.ts';
import { evaluationSource, isExpression } from '../../src/scripts/api.ts';
import { ChatClient, LlmError, splitThinking, type ChatMessage } from '../../src/agents/llm.ts';
import { AgentRun, questionRefusal, questionsAllowed, type AgentInput, type AgentKind } from '../../src/agents/run.ts';
import { decodeResultUrl } from '../../src/agents/search.ts';
import { chatCompletionsUrl, loadConfig } from '../../src/config.ts';
import { Hub, type HubEvent } from '../../src/dashboard/hub.ts';
import { LogTap } from '../../src/logger.ts';
import { MAX_WAITING } from '../../src/util/limits.ts';
import { REDACTED, scrubDeep, scrubText } from '../../src/util/scrub.ts';
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

  test('questions to the host: a 30 min reply timeout and 5 questions per run by default; 0 turns them off', () => {
    const c = loadConfig({});
    assert.equal(c.agent.replyTimeoutMs, 1_800_000);
    assert.equal(c.agent.maxQuestions, 5);
    assert.equal(loadConfig({ AGENT_REPLY_TIMEOUT_MS: '10000' }).agent.replyTimeoutMs, 10_000);
    assert.equal(loadConfig({ AGENT_MAX_QUESTIONS: '0' }).agent.maxQuestions, 0);
    assert.equal(loadConfig({ AGENT_MAX_QUESTIONS: '50' }).agent.maxQuestions, 50);
    assert.throws(() => loadConfig({ AGENT_REPLY_TIMEOUT_MS: '9999' }), /AGENT_REPLY_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ AGENT_REPLY_TIMEOUT_MS: 'soon' }), /AGENT_REPLY_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ AGENT_MAX_QUESTIONS: '51' }), /AGENT_MAX_QUESTIONS/);
    assert.throws(() => loadConfig({ AGENT_MAX_QUESTIONS: '-1' }), /AGENT_MAX_QUESTIONS/);
  });
});

describe('sub-agent questions to the host', () => {
  const config = loadConfig({ AGENT_LLM_URL: 'http://127.0.0.1:1/v1' });
  const input = (extra: Partial<AgentInput> = {}): AgentInput => ({ task: 'Buy the cable', output: 'the order number', outputFormat: 'text', maxSteps: 20, ...extra });
  const newRun = (kind: AgentKind = 'task', extra: Partial<AgentInput> = {}) => {
    const run = new AgentRun('r1a2b3c4', kind, input(extra), 'host-client');
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    return run;
  };
  const env = (waiting = 0, cfg = config) => ({ config: cfg, waitingCount: () => waiting }) as any;

  test('who may ask: task and automation agents, unless the host or AGENT_MAX_QUESTIONS=0 says no; never the finder', () => {
    assert.equal(questionsAllowed(newRun('task'), config), true);
    assert.equal(questionsAllowed(newRun('automation'), config), true);
    assert.equal(questionsAllowed(newRun('finder'), config), false);
    assert.equal(questionsAllowed(newRun('task', { allowQuestions: false }), config), false);
    assert.equal(questionsAllowed(newRun('task'), loadConfig({ AGENT_LLM_URL: 'http://127.0.0.1:1/v1', AGENT_MAX_QUESTIONS: '0' })), false);
  });

  test('a question is refused (the run does not pause) at the cap, when too many runs wait, or with too little budget left', () => {
    const run = newRun();
    run.deadline = Date.now() + 10 * 60_000;
    run.step = 1;
    assert.equal(questionRefusal(run, env()), null);
    run.questionTurns = 5;
    assert.match(questionRefusal(run, env())!, /^you already asked 5 questions, the limit for one job\. Decide on your own/);
    run.questionTurns = 0;
    assert.match(questionRefusal(run, env(MAX_WAITING))!, /^too many jobs are waiting for the host right now \(10\)/);
    assert.equal(questionRefusal(run, env(MAX_WAITING - 1)), null);
    run.step = 18; // 2 steps left: not enough to act on an answer
    assert.equal(questionRefusal(run, env()), 'too little budget left to act on an answer; finish with success=false and say what needs approval');
    run.questionTurns = 1; // question turns are free: 3 steps left again
    assert.equal(questionRefusal(run, env()), null);
    run.deadline = Date.now() + 90_000;
    assert.match(questionRefusal(run, env())!, /^too little budget left/);
  });

  test('a waiting run reports its question, the reason hint and the exact agent_reply call', async () => {
    const run = newRun();
    run.step = 2;
    const closed = run.ask({ text: 'Place the order for the USB-C cable, $12.99?', options: ['Yes', 'No'], reason: 'confirm', secret: false, pageUrl: 'https://shop.example/checkout?step=2' }, 1_800_000);
    try {
      const q = run.question!;
      assert.match(q.id, /^q[0-9a-f]{6}$/);
      assert.equal(run.status, 'waiting');
      assert.equal(run.isWaiting, true);
      assert.equal(run.stepsUsed, 1, 'the question turn is free');
      const r = runResult(run);
      assert.equal(r.isError, false);
      assert.equal(
        r.text,
        [
          `Run r1a2b3c4 is waiting for your answer (question ${q.id}, asked on https://shop.example):`,
          '',
          'Place the order for the USB-C cable, $12.99?',
          '',
          'Options: Yes | No',
          '',
          'This asks you to approve a step that cannot be undone: ask your user unless they already approved exactly this.',
          '',
          `The run is paused and keeps its browser. Answer with agent_reply {"run_id": "r1a2b3c4", "question_id": "${q.id}", "answer": "..."}`,
          'Unanswered after 30 min it continues without an answer; agent_cancel stops it. Do not end your turn while it waits.',
        ].join('\n'),
      );
      assert.equal(r.structured.status, 'waiting');
      assert.equal(r.structured.steps, 1);
      assert.deepEqual(r.structured.question, {
        id: q.id,
        text: 'Place the order for the USB-C cable, $12.99?',
        options: ['Yes', 'No'],
        reason: 'confirm',
        secret: false,
        page_url: 'https://shop.example/checkout?step=2',
        origin: 'https://shop.example',
        asked_at: q.askedAt,
        expires_at: q.expiresAt,
      });
      assert.deepEqual(r.structured.reply_with, { tool: 'agent_reply', arguments: { run_id: 'r1a2b3c4', question_id: q.id, answer: '<your answer>' } });
      const summary = run.summary() as any;
      assert.equal(summary.status, 'waiting');
      assert.equal(summary.question?.id, q.id);
      assert.equal(summary.questions, 1);
    } finally {
      run.closeQuestion('cancelled');
    }
    assert.equal((await closed).status, 'cancelled');
  });

  test('closing a question changes the run at once; the answer is recorded and reported with the result', async () => {
    const run = newRun();
    run.step = 1;
    const closed = run.ask({ text: 'Which colour?', options: ['red', 'blue'], reason: 'choose', secret: false, pageUrl: null }, 60_000);
    assert.match(runResult(run).text, /asked on no web page/);
    assert.doesNotMatch(runResult(run).text, /cannot be undone|never send a password/, 'no hint for a plain choice');
    const record = run.closeQuestion('answered', { answer: 'blue', by: 'other-client' })!;
    // synchronously, before the paused tool call even resumes
    assert.equal(run.status, 'running');
    assert.equal(run.question, null);
    assert.equal(run.isWaiting, false);
    assert.equal(run.activity, 'resuming: waiting for a free agent slot');
    assert.equal(record.status, 'answered');
    assert.equal(record.answer, 'blue');
    assert.equal(record.answeredBy, 'other-client');
    assert.equal(run.closeQuestion('expired'), null, 'a closed question cannot be closed again');
    assert.deepEqual(await closed, { status: 'answered', answer: 'blue', secret: false });

    run.endPause();
    assert.ok(run.pausedMs >= 0);
    run.outcome = { success: true, output: 'ORDER-1' };
    run.finish('completed');
    const r = runResult(run);
    assert.match(r.text, /Questions the agent asked you \(paused [\d.]+ s in total\):\n- q[0-9a-f]{6} \(choose, answered\): Which colour\? → "blue"/);
    assert.deepEqual(r.structured.questions, [
      { id: record.id, text: 'Which colour?', reason: 'choose', origin: null, answer: 'blue', asked_at: record.askedAt, answered_at: record.answeredAt, status: 'answered' },
    ]);
    assert.equal(typeof r.structured.waited_ms, 'number');
  });

  test('a question that expires or is cancelled carries no answer', async () => {
    const run = newRun();
    const expired = run.ask({ text: 'Size?', options: [], reason: 'missing_info', secret: false, pageUrl: null }, 60_000);
    run.closeQuestion('expired');
    assert.deepEqual(await expired, { status: 'expired', answer: null, secret: false });
    assert.equal(run.questions[0]!.status, 'expired');
    assert.equal(run.questions[0]!.answer, null);
    assert.equal(run.questions[0]!.answeredAt, null);

    const cancelled = run.ask({ text: 'Again?', options: [], reason: 'missing_info', secret: false, pageUrl: null }, 60_000);
    run.abort.abort();
    assert.deepEqual(await cancelled, { status: 'cancelled', answer: null, secret: false });
    assert.equal(run.questions[1]!.status, 'cancelled');
    assert.equal(run.questionTurns, 2);
  });

  test('a secret answer reaches the model only: it is never stored, and masked in everything the run reports', async () => {
    const run = newRun();
    const closed = run.ask({ text: 'What is the sign-in code?', options: [], reason: 'sign_in', secret: true, pageUrl: 'https://login.shop.example/otp' }, 1_800_000);
    const waiting = runResult(run);
    assert.match(waiting.text, /Tell your user which site asks \(see "asked on"\); never send a password; do not relay a code for a site the task did not name\./);
    assert.match(waiting.text, /"answer": "\.\.\.", "secret": true\}/);
    assert.equal((waiting.structured.reply_with as any).arguments.secret, true);
    run.closeQuestion('answered', { answer: ' 482913 ', by: 'host-client' });
    assert.deepEqual(await closed, { status: 'answered', answer: ' 482913 ', secret: true }, 'the model gets the real answer');
    assert.equal(run.questions[0]!.answer, null);
    assert.equal(run.questions[0]!.answerChars, 8);
    assert.ok(run.secretValues.has('482913'), 'trimmed');
    assert.equal(run.scrub('typed 482913 into Code'), `typed ${REDACTED} into Code`);

    run.thinking = 'I will type 482913 now';
    assert.doesNotMatch(String(run.summary().thinking), /482913/);
    run.outcome = { success: true, output: 'Signed in with code 482913', notes: 'used 482913' };
    run.notes.push('code is 482913');
    run.finish('completed');
    const r = runResult(run);
    assert.doesNotMatch(r.text, /482913/);
    assert.doesNotMatch(JSON.stringify(r.structured), /482913/);
    assert.equal((r.structured.questions as any[])[0].answer, REDACTED);
    assert.match(String(r.structured.output), /Signed in with code \[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(run.summary()), /482913/);
    assert.equal(run.outcome.output, 'Signed in with code 482913', 'the run itself is unchanged');
  });

  test('the host can mark an answer secret; very short answers are not masked by value', async () => {
    const run = newRun();
    const first = run.ask({ text: 'Which account?', options: [], reason: 'choose', secret: false, pageUrl: null }, 60_000);
    run.closeQuestion('answered', { answer: 'work-7781', secret: true, by: null });
    await first;
    assert.equal(run.questions[0]!.secret, true);
    assert.equal(run.questions[0]!.answer, null);
    assert.ok(run.secretValues.has('work-7781'));
    const second = run.ask({ text: 'PIN?', options: [], reason: 'sign_in', secret: true, pageUrl: null }, 60_000);
    run.closeQuestion('answered', { answer: 'yes', by: null });
    await second;
    assert.equal(run.secretValues.has('yes'), false, 'masking "yes" everywhere would hide ordinary words');
    assert.equal(run.questions[1]!.answer, null, 'but it is still not stored');
  });

  test('masking helpers replace every occurrence, longest secret first, and keep unchanged values as they are', () => {
    const secrets = new Set(['1234', '123456']);
    assert.equal(scrubText('a 123456 b 1234 c', secrets), `a ${REDACTED} b ${REDACTED} c`);
    assert.equal(scrubText('nothing here', secrets), 'nothing here');
    assert.equal(scrubText('1234', new Set()), '1234');
    const scrub = (t: string) => scrubText(t, secrets);
    const value = { a: ['x 1234', { b: 'y' }], n: 5, keep: { c: 'z' } };
    const out = scrubDeep(value, scrub);
    assert.deepEqual(out, { a: [`x ${REDACTED}`, { b: 'y' }], n: 5, keep: { c: 'z' } });
    assert.equal(out.keep, value.keep, 'unchanged parts are not copied');
    assert.equal(value.a[0], 'x 1234', 'the input is not modified');
    const date = new Date(0);
    assert.equal(scrubDeep(date, scrub), date, 'class instances are left alone');
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

  test('over 100 runs the oldest finished ones are dropped first; queued, running and waiting runs never', () => {
    const hub = new Hub(new LogTap());
    hub.publishAgent({ id: 'waiting-1', kind: 'task', status: 'waiting' });
    hub.publishAgent({ id: 'running-1', kind: 'task', status: 'running' });
    hub.publishAgent({ id: 'queued-1', kind: 'task', status: 'queued' });
    for (let i = 0; i < 120; i++) hub.publishAgent({ id: `done-${i}`, kind: 'task', status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'cancelled' : 'completed' });
    const ids = hub.history().agents.map((a: any) => a.id);
    assert.equal(ids.length, 100);
    assert.deepEqual(ids.slice(0, 3), ['waiting-1', 'running-1', 'queued-1']);
    assert.equal(ids[3], 'done-23', 'the oldest finished runs went first');
    assert.equal(ids.at(-1), 'done-119');

    // more unfinished runs than the cap: none is dropped
    const busy = new Hub(new LogTap());
    for (let i = 0; i < 105; i++) busy.publishAgent({ id: `w-${i}`, kind: 'task', status: i % 2 ? 'waiting' : 'running' });
    assert.equal(busy.history().agents.length, 105);
    // once one of them finishes it is the only one that can go
    busy.publishAgent({ id: 'w-0', kind: 'task', status: 'completed' });
    assert.equal(busy.history().agents.length, 104);
    assert.ok(!busy.history().agents.some((a: any) => a.id === 'w-0'));
    assert.ok(busy.history().agents.every((a: any) => a.status !== 'completed'));
  });

  test('the snapshots list reaches every viewer and is kept for viewers that connect later', () => {
    const hub = new Hub(new LogTap());
    assert.equal(hub.history().snapshots, null);
    const agentViewer: HubEvent[] = [];
    hub.subscribe((e) => agentViewer.push(e), false, 'agent-r9');
    const payload = { snapshots: [{ name: 'shop', loaded_in: ['main'], active_in: ['main'] }], dir: '/data/snapshots', encrypted: false, unencrypted_count: 1 };
    hub.publish('snapshots', payload);
    assert.deepEqual(agentViewer.map((e) => e.type), ['snapshots'], 'not scoped to one browser');
    assert.equal(hub.history().snapshots, payload);
    assert.equal(hub.history('agent-r9').snapshots, payload);
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
