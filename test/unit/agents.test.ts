import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pino from 'pino';
import { TokenMeter, compactTranscript, parseToolArguments, transcriptChars } from '../../src/agents/conversation.ts';
import { runResult } from '../../src/agents/format.ts';
import { KINDS, isSearchResultsPage, quoteFound, quoteMatch, siteOf } from '../../src/agents/kinds.ts';
import { redactParams, serverInstructions } from '../../src/mcp/server.ts';
import { agentAutomate, agentReply, agentRun, agentStatus } from '../../src/tools/agents.ts';
import { evaluationSource, isExpression } from '../../src/scripts/api.ts';
import { ChatClient, LlmError, splitThinking, type ChatMessage } from '../../src/agents/llm.ts';
import { AgentRun, looksLikeFinalPurchase, purchaseGuardFor, questionRefusal, questionsAllowed, type AgentInput, type AgentKind } from '../../src/agents/run.ts';
import { decodeResultUrl } from '../../src/agents/search.ts';
import { chatCompletionsUrl, loadConfig } from '../../src/config.ts';
import { Hub, type HubEvent } from '../../src/dashboard/hub.ts';
import { LogTap } from '../../src/logger.ts';
import { MAX_WAITING } from '../../src/util/limits.ts';
import { REDACTED, scrubDeep, scrubText, secretParts } from '../../src/util/scrub.ts';
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
    assert.equal(questionRefusal(run, env(), 'choose'), null);
    // the cap counts questions asked (answered, expired or cancelled), not turns
    for (let i = 0; i < 5; i++) run.questions.push({ status: 'answered' } as any);
    assert.match(questionRefusal(run, env(), 'choose')!, /^you already asked 5 questions, the limit for one job\. Decide on your own/);
    run.questions.length = 0;
    assert.match(questionRefusal(run, env(MAX_WAITING), 'missing_info')!, /^too many jobs are waiting for the host right now \(10\)\. Decide on your own/);
    assert.equal(questionRefusal(run, env(MAX_WAITING - 1), 'choose'), null);
    run.step = 18; // 2 steps left: not enough to act on an answer
    assert.equal(questionRefusal(run, env(), 'choose'), 'too little budget left to act on an answer; finish with success=false and say what needs approval');
    run.questionTurns = 1; // question turns are free: 3 steps left again
    assert.equal(questionRefusal(run, env(), 'choose'), null);
    run.deadline = Date.now() + 90_000;
    assert.match(questionRefusal(run, env(), 'choose')!, /^too little budget left/);
  });

  test('a refused confirm or sign-in question never leaves the step to the agent: it must finish without it', () => {
    const run = newRun();
    run.deadline = Date.now() + 10 * 60_000;
    for (let i = 0; i < 5; i++) run.questions.push({ status: 'answered' } as any);
    const confirm = questionRefusal(run, env(), 'confirm')!;
    assert.equal(
      confirm,
      "you already asked 5 questions, the limit for one job. Do not take the step you wanted to confirm (do not place the order or pay): call finish with success=false and say what needs the host's approval.",
    );
    assert.doesNotMatch(confirm, /on your own/);
    assert.equal(
      questionRefusal(run, env(), 'sign_in'),
      'you already asked 5 questions, the limit for one job. Call finish with success=false and say which site needs a sign-in and what it asks for.',
    );
    run.questions.length = 0;
    assert.match(questionRefusal(run, env(MAX_WAITING), 'confirm')!, /^too many jobs are waiting for the host right now \(10\)\. Do not take the step you wanted to confirm/);
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
          'This asks you to approve a step that cannot be undone. Ask your user to approve it, then answer with agent_reply. ' +
            'If your user already approved exactly this earlier in your conversation, approve it yourself.',
          '',
          `The run is paused and keeps its browser. Answer with agent_reply {"run_id": "r1a2b3c4", "question_id": "${q.id}", "answer": "..."}`,
          'Answer it now, or ask your user and answer when they reply (the run waits up to 30 min, then continues without an answer; agent_cancel stops it). ' +
            'Never approve a purchase your user did not approve, and never send a code on your own.',
        ].join('\n'),
      );
      assert.doesNotMatch(r.text, /Do not end your turn/, 'a chat host asks its user by ending its turn');
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
        purchase_approval: null,
      });
      assert.deepEqual(r.structured.reply_with, { tool: 'agent_reply', arguments: { run_id: 'r1a2b3c4', question_id: q.id, answer: '<your answer>' } });
      const summary = run.summary() as any;
      assert.equal(summary.status, 'waiting');
      assert.equal(summary.question?.id, q.id);
      assert.equal(summary.questions, 1);
      assert.equal(summary.purchaseApproval, null);
    } finally {
      run.closeQuestion('cancelled');
    }
    assert.equal((await closed).status, 'cancelled');
  });

  test('a confirm question of a job with a purchase approval shows it, so the host approves a matching checkout itself (agent_run and agent_automate)', async () => {
    const approval = 'Approved: one USB-C cable, total up to $15, to my default address, with the saved card';
    const hint =
      'This asks you to approve a step that cannot be undone. ' +
      `Your user approved in advance (purchase_approval): "${approval}". ` +
      'Approve it yourself now with agent_reply, without asking your user, only if those words are your user\'s explicit approval ("I approve", "go ahead", a maximum price), not just their request to buy, ' +
      'and this checkout matches them (item, quantity, total within the limit, address, payment method). Otherwise ask your user and answer with their decision.';
    const run = newRun('task', { purchaseApproval: approval });
    run.step = 3;
    const closed = run.ask({ text: 'Place the order for the USB-C cable, total $12.99?', options: ['Yes', 'No'], reason: 'confirm', secret: false, pageUrl: 'https://shop.example/checkout' }, 1_800_000);
    try {
      const r = runResult(run);
      assert.equal(r.text.split('\n\n')[3], hint);
      assert.match(r.text, /Never approve a purchase your user did not approve, and never send a code on your own\.$/);
      assert.doesNotMatch(r.text, /confirm_purchases|Ask your user to approve it/);
      assert.equal((r.structured.question as any).purchase_approval, approval);
      assert.equal((run.summary() as any).purchaseApproval, approval, 'the dashboard card shows it');
    } finally {
      run.closeQuestion('cancelled');
    }
    await closed;

    // other questions carry no approval
    const choose = run.ask({ text: 'Which colour?', options: [], reason: 'choose', secret: false, pageUrl: null }, 60_000);
    assert.equal('purchase_approval' in (runResult(run).structured.question as any), false);
    run.closeQuestion('cancelled');
    await choose;

    // an automation agent asks before it orders too, and its confirm questions get the same hints
    const automation = newRun('automation', { purchaseApproval: approval });
    automation.step = 3;
    const pending = automation.ask({ text: 'Place the order for the USB-C cable, total $12.99?', options: [], reason: 'confirm', secret: false, pageUrl: 'https://shop.example/checkout' }, 60_000);
    const auto = runResult(automation);
    assert.equal(auto.text.split('\n\n')[2], hint);
    assert.equal((auto.structured.question as any).purchase_approval, approval);
    assert.equal((automation.summary() as any).purchaseApproval, approval);
    automation.closeQuestion('cancelled');
    await pending;
    const plain = newRun('automation');
    const asked = plain.ask({ text: 'Send the message?', options: [], reason: 'confirm', secret: false, pageUrl: null }, 60_000);
    const text = runResult(plain).text;
    assert.match(
      text,
      /\n\nThis asks you to approve a step that cannot be undone\. Ask your user to approve it, then answer with agent_reply\. If your user already approved exactly this earlier in your conversation, approve it yourself\.\n\n/,
    );
    assert.equal((runResult(plain).structured.question as any).purchase_approval, null);
    plain.closeQuestion('cancelled');
    await asked;
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

    run.step = 1;
    const cancelled = run.ask({ text: 'Again?', options: [], reason: 'missing_info', secret: false, pageUrl: null }, 60_000);
    run.abort.abort();
    assert.deepEqual(await cancelled, { status: 'cancelled', answer: null, secret: false });
    assert.equal(run.questions[1]!.status, 'cancelled');
    assert.equal(run.questionTurns, 2);
  });

  test('a model turn is free once, however many questions it paused on: the steps used never go below the turns that asked nothing', async () => {
    const run = newRun();
    run.step = 3;
    for (const text of ['First?', 'Second?']) {
      const closed = run.ask({ text, options: [], reason: 'choose', secret: false, pageUrl: null }, 60_000);
      run.closeQuestion('answered', { answer: 'a', by: null });
      await closed;
    }
    assert.equal(run.questionTurns, 1);
    assert.equal(run.stepsUsed, 2);
  });

  test('a secret answer reaches the model only: it is never stored, and masked in everything the run reports', async () => {
    const run = newRun();
    const closed = run.ask({ text: 'What is the sign-in code?', options: [], reason: 'sign_in', secret: true, pageUrl: 'https://login.shop.example/otp' }, 1_800_000);
    const waiting = runResult(run);
    assert.match(waiting.text, /Tell your user which site asks \(see "asked on"\); never send a password; do not relay a code for a site the task did not name\./);
    assert.match(waiting.text, /Send only the code or secret itself as the answer, e\.g\. "482913", not a sentence\./);
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

  test('a code sent inside a sentence is masked as the code the agent types, not only as the whole sentence', async () => {
    const run = newRun();
    const closed = run.ask({ text: 'What is the sign-in code?', options: [], reason: 'sign_in', secret: true, pageUrl: null }, 60_000);
    run.closeQuestion('answered', { answer: 'The code is 482 913, backup K7Q2-Z9X4.', by: null });
    await closed;
    for (const typed of ['482913', '482 913', 'K7Q2-Z9X4', 'K7Q2Z9X4']) assert.equal(run.scrub(`typed ${typed}`), `typed ${REDACTED}`, typed);
    assert.equal(run.scrub('The code is sent by text'), 'The code is sent by text', 'plain words are not masked');
    assert.deepEqual(secretParts('yes'), []);
    assert.deepEqual(secretParts('The code is 482913.'), ['The code is 482913.', '482913']);
    assert.deepEqual(secretParts(' hunter-two '), ['hunter-two'], 'an answer without digits is masked whole');
  });

  test('a later question that quotes a secret answer is shown masked: the waiting result, the run summary and the final result', async () => {
    const run = newRun();
    const first = run.ask({ text: 'What is the sign-in code?', options: [], reason: 'sign_in', secret: true, pageUrl: null }, 60_000);
    run.closeQuestion('answered', { answer: 'K7Q2Z9X4', by: null });
    await first;
    run.step = 2;
    const second = run.ask(
      { text: 'The site rejected the code K7Q2Z9X4 (expired). Send the new code?', options: ['K7Q2Z9X4 again', 'a new code'], reason: 'sign_in', secret: true, pageUrl: 'https://login.shop.example/otp?code=K7Q2Z9X4' },
      60_000,
    );
    const waiting = runResult(run);
    assert.match(waiting.text, /The site rejected the code \[REDACTED\] \(expired\)/);
    for (const shown of [waiting.text, JSON.stringify(waiting.structured), JSON.stringify(run.summary()), JSON.stringify(run.questionLog())]) {
      assert.ok(!shown.includes('K7Q2Z9X4'), shown);
    }
    run.closeQuestion('answered', { answer: 'M3N4P5Q6', by: null });
    await second;
    run.outcome = { success: true, output: 'signed in' };
    run.finish('completed');
    const done = runResult(run);
    assert.ok(!done.text.includes('K7Q2Z9X4') && !JSON.stringify(done.structured).includes('K7Q2Z9X4'));
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

describe('which waiting runs are the caller\'s to answer', () => {
  const input: AgentInput = { task: 'Pick a colour', output: 'the colour', outputFormat: 'text', maxSteps: 20 };
  const waitingRun = (id: string, client: string | null, sessionId: string | null, question: string) => {
    const run = new AgentRun(id, 'task', input, client, sessionId);
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.step = 1;
    void run.ask({ text: question, options: [], reason: 'choose', secret: false, pageUrl: null }, 60_000);
    return run;
  };
  /** The tool context of a caller, with a manager that holds `runs` (most recent first). */
  const ctxOf = (runs: AgentRun[], session: { id: string | null; client: string | null }) =>
    ({
      session,
      agents: {
        get: (id: string) => runs.find((r) => r.id === id),
        list: () => runs,
        waitingRuns: () => runs.filter((r) => r.isWaiting),
        activeCount: 0,
        queuedCount: 0,
        waitingCount: runs.filter((r) => r.isWaiting).length,
      },
    }) as any;

  test('startedBy: the same MCP session when the run and the caller have one, otherwise the same client label', () => {
    const run = new AgentRun('r1111111', 'task', input, 'cli 1.0.0', 'session-a');
    assert.equal(run.startedBy({ id: 'session-a', client: 'cli 1.0.0' }), true);
    assert.equal(run.startedBy({ id: 'session-b', client: 'cli 1.0.0' }), false, 'another session of the same client');
    assert.equal(run.startedBy({ id: 'session-b', client: 'other 2.0.0' }), false);
    assert.equal(run.startedBy({ id: null, client: 'cli 1.0.0' }), true, 'a stateless caller: by its label');
    assert.equal(run.startedBy({ id: null, client: 'other 2.0.0' }), false);
    const stateless = new AgentRun('r2222222', 'task', input, 'cli 1.0.0');
    assert.equal(stateless.startedBy({ id: 'session-a', client: 'cli 1.0.0' }), true, 'a run a stateless call started: by its label');
    assert.equal(stateless.startedBy({ id: 'session-a', client: 'other 2.0.0' }), false);
    assert.equal(stateless.startedBy({ id: null, client: 'cli 1.0.0' }), true);
    assert.equal(new AgentRun('r3333333', 'task', input, null).startedBy({ id: null, client: null }), true, 'no label on either side, as before');
    // the session id stays on the server: not in the run's summary (dashboard, agent_status list, transcript)
    assert.ok(!JSON.stringify(run.summary()).includes('session-a'));
  });

  test('"Also waiting" and the agent_status list tell two sessions of the same client apart', async () => {
    const mine = waitingRun('raaaaaa1', 'cli 1.0.0', 'session-a', 'Which colour for A?');
    const sameClient = waitingRun('rbbbbbb2', 'cli 1.0.0', 'session-b', 'Which colour for B?');
    const otherClient = waitingRun('rcccccc3', 'other 2.0.0', 'session-c', 'Which colour for C?');
    const stateless = waitingRun('rdddddd4', 'cli 1.0.0', null, 'Which colour for D?');
    const runs = [stateless, otherClient, sameClient, mine];
    try {
      // session A looks at its own run: its other runs are the stateless one of its label, never session B's
      const a = await agentStatus.handler({ run_id: mine.id }, ctxOf(runs, { id: 'session-a', client: 'cli 1.0.0' }));
      const aText = String((a.content[0] as any).text);
      assert.match(aText, /\n\nAlso waiting for your answer: run rdddddd4 \(question q[0-9a-f]{6}: Which colour for D\?\)$/);
      assert.doesNotMatch(aText, /rbbbbbb2|rcccccc3/);
      assert.deepEqual((a.structuredContent as any).also_waiting.map((w: any) => w.run_id), ['rdddddd4']);

      // session B sees its run as its own, and session A's as another session's
      const list = await agentStatus.handler({}, ctxOf(runs, { id: 'session-b', client: 'cli 1.0.0' }));
      const lines = String((list.content[0] as any).text).split('\n');
      const line = (id: string) => lines.find((l) => l.startsWith(id)) ?? '';
      assert.match(line('raaaaaa1'), /asks q[0-9a-f]{6}: Which colour for A\? \(started by another session of cli 1\.0\.0: theirs to answer\)$/);
      assert.match(line('rbbbbbb2'), /asks q[0-9a-f]{6}: Which colour for B\?$/);
      assert.match(line('rcccccc3'), /asks q[0-9a-f]{6}: Which colour for C\? \(started by other 2\.0\.0: theirs to answer\)$/);
      assert.match(line('rdddddd4'), /asks q[0-9a-f]{6}: Which colour for D\?$/, 'a run started without a session belongs to its label');
      assert.match(lines.at(-1)!, /^Answer a waiting run you started with agent_reply/);

      // a stateless caller (no session id) falls back to its label: every run of its client label is its own
      const s = await agentStatus.handler({ run_id: otherClient.id }, ctxOf(runs, { id: null, client: 'cli 1.0.0' }));
      assert.deepEqual((s.structuredContent as any).also_waiting.map((w: any) => w.run_id), ['rdddddd4', 'rbbbbbb2', 'raaaaaa1']);

      // a new session of the other client has no waiting run of its own: every run is theirs, and no reply hint
      const other = await agentStatus.handler({}, ctxOf(runs, { id: 'session-f', client: 'other 2.0.0' }));
      const otherText = String((other.content[0] as any).text);
      assert.doesNotMatch(otherText, /Answer a waiting run you started/);
      assert.match(otherText, /Which colour for C\? \(started by another session of other 2\.0\.0: theirs to answer\)/);
      assert.match(otherText, /Which colour for D\? \(started by cli 1\.0\.0: theirs to answer\)/);
      const none = await agentStatus.handler({ run_id: otherClient.id }, ctxOf(runs, { id: 'session-f', client: 'other 2.0.0' }));
      assert.doesNotMatch(String((none.content[0] as any).text), /Also waiting/);
      assert.equal((none.structuredContent as any).also_waiting, undefined);
    } finally {
      for (const run of runs) run.closeQuestion('cancelled');
    }
  });
});

describe('sub-agent purchases need the host', () => {
  const config = loadConfig({ AGENT_LLM_URL: 'http://127.0.0.1:1/v1' });
  const newRun = (kind: AgentKind = 'task', extra: Partial<AgentInput> = {}) => {
    const run = new AgentRun('r5e6f7a8', kind, { task: 'Order one Blue Mug', output: 'the order number', outputFormat: 'text', maxSteps: 20, ...extra }, 'host-client');
    run.status = 'running';
    run.deadline = Date.now() + 10 * 60_000;
    return run;
  };

  test('final order and payment buttons are recognised by their label; the checkout steps before them are not', () => {
    const final = [
      'Place your order',
      'place order',
      'Place Order and Pay',
      '  Place \n the   order ',
      '🔒 Place your order',
      'Place your order Order total: $17.49',
      'Buy now',
      'Buy it now',
      'Order now',
      'Complete purchase',
      'Complete your order',
      'Complete checkout',
      'Confirm and pay',
      'Confirm order',
      'Confirm your payment',
      'Submit order',
      'Submit my order',
      'Pay now',
      'Pay $17.49',
      'Pay 17.49',
      'Pay US$ 17',
      'Pay EUR 17',
      'Pay',
      'Purchase',
      'Purchase now',
      'Finish checkout',
      'Donate',
      'Donate now',
      'Donate $25',
      'Send money',
      'Transfer money',
      'Send $50',
    ];
    for (const label of final) assert.equal(looksLikeFinalPurchase(label), true, label);
    const before = [
      'Proceed to checkout',
      'Checkout',
      'Add to cart',
      'Continue to payment',
      'Payment method',
      'PayPal',
      'Pay with card',
      'Pay in 3 installments',
      'Sign in',
      'Apply coupon',
      'Purchase history',
      'Order history',
      'Your orders',
      'Confirm address',
      'Donate monthly',
      'Place a bid',
      '',
    ];
    for (const label of before) assert.equal(looksLikeFinalPurchase(label), false, label);
  });

  test('the purchase guard blocks the final step until the host answered a confirm question on that page, also with a purchase approval', async () => {
    const CHECKOUT = 'https://shop.example/checkout';
    const warned: unknown[] = [];
    const env = { config, log: { warn: (obj: unknown) => warned.push(obj) }, waitingCount: () => 0 } as any;
    const run = newRun();
    assert.equal(KINDS.task.purchaseGuard, purchaseGuardFor);
    assert.equal(KINDS.automation.purchaseGuard, purchaseGuardFor, 'an automation agent explores the checkout like a task agent');
    assert.equal(KINDS.finder.purchaseGuard, undefined, 'research only');
    const guard = purchaseGuardFor(run, env);
    assert.equal(guard('Proceed to checkout', CHECKOUT), null);
    const blocked =
      'Blocked: "Place your order" looks like the final step of an order or payment. Ask the host first: call ask_host with reason "confirm", ' +
      'giving the item, the total price, the delivery address and the payment method. Click it again after the host approves.';
    assert.equal(guard('Place your order', CHECKOUT), blocked);
    assert.equal(warned.length, 1, 'a blocked step is logged');

    // a choose answer or an expired confirm question does not lift it
    for (const [reason, status] of [['choose', 'answered'], ['confirm', 'expired']] as const) {
      const closed = run.ask({ text: 'Which one?', options: [], reason, secret: false, pageUrl: null }, 60_000);
      run.closeQuestion(status, status === 'answered' ? { answer: 'the blue one', by: null } : undefined);
      await closed;
      assert.equal(guard('Place your order', CHECKOUT), blocked, `${reason} ${status}`);
    }
    // an approval asked on another page (the cart, before the total was shown) does not unlock the checkout's button
    const early = run.ask({ text: 'Order the Blue Mug?', options: [], reason: 'confirm', secret: false, pageUrl: 'https://shop.example/cart' }, 60_000);
    run.closeQuestion('answered', { answer: 'Yes.', by: null });
    await early;
    assert.equal(
      guard('Place your order', CHECKOUT),
      'Blocked: "Place your order" looks like the final step of an order or payment, and the host\'s approval was for a question you asked on another page (https://shop.example/cart). ' +
        'Ask again on this page: call ask_host with reason "confirm", giving the item, the total price, the delivery address and the payment method it shows. Click it again after the host approves.',
    );
    // a confirm question answered on the checkout page lifts it there, whatever the answer (the agent respects a "No");
    // the query and the fragment may differ
    const confirm = run.ask({ text: 'Place the order for the Blue Mug, $17.49?', options: [], reason: 'confirm', secret: false, pageUrl: `${CHECKOUT}?step=review` }, 60_000);
    run.closeQuestion('answered', { answer: 'Yes, place the order.', by: null });
    await confirm;
    assert.equal(guard('Place your order', `${CHECKOUT}/#pay`), null);
    assert.notEqual(guard('Place your order', 'https://other.example/checkout'), null, 'another site');

    // approved in advance: the agent still asks, and the button stays blocked until the host answers
    assert.equal(purchaseGuardFor(newRun('task', { purchaseApproval: 'Approved: one Blue Mug, up to $20' }), env)('Place your order', CHECKOUT), blocked);
    // confirm_purchases (replaced by purchase_approval) no longer turns the guard off, even if it reached the input
    assert.equal(purchaseGuardFor(newRun('task', { confirmPurchases: false } as Partial<AgentInput>), env)('Place your order', CHECKOUT), blocked);
    const quietBlocked =
      'Blocked: "Pay $17.49" looks like the final step of an order or payment, and this job needs the host\'s approval for it but questions are off. ' +
      'Call finish with success=false and say the order is ready to be placed (item, total, address, payment method).';
    assert.equal(purchaseGuardFor(newRun('task', { allowQuestions: false }), env)('Pay $17.49', CHECKOUT), quietBlocked);
    assert.equal(purchaseGuardFor(newRun('automation', { allowQuestions: false, purchaseApproval: 'Approved: up to $20' }), env)('Pay $17.49', CHECKOUT), quietBlocked);
  });

  test('agent_run and agent_automate: purchase_approval is trimmed text of at most 500 characters; confirm_purchases from an old client is dropped, not refused', () => {
    const parsed = agentRun.inputSchema.safeParse({ task: 'x', output: 'y', confirm_purchases: false, purchase_approval: '  Approved: one Blue Mug, up to $20  ' });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { task: 'x', output: 'y', purchase_approval: 'Approved: one Blue Mug, up to $20' });
    for (const tool of [agentRun, agentAutomate]) {
      const schema = tool.inputSchema;
      assert.equal(schema.safeParse({ task: 'x', output: 'y', purchase_approval: '   ' }).success, false, tool.name);
      assert.equal(schema.safeParse({ task: 'x', output: 'y', purchase_approval: 'x'.repeat(501) }).success, false, tool.name);
      assert.equal(schema.safeParse({ task: 'x', output: 'y', purchase_approval: 'x'.repeat(500) }).success, true, tool.name);
      assert.doesNotMatch(tool.description, /confirm_purchases/);
      assert.doesNotMatch(tool.inputSchema.shape.allow_questions.description ?? '', /explicit approval in the TASK/, 'questions off: no agent orders');
    }
    assert.equal((agentAutomate.inputSchema.safeParse({ task: 'x', output: 'y', purchase_approval: ' Approved: 1 mug ' }).data as any).purchase_approval, 'Approved: 1 mug');
    assert.match(agentRun.description, /The agent always asks you before it places an order or pays, and the server enforces it\. If your user explicitly approved the purchase \(not just asked for it\), pass their words as purchase_approval/);
    assert.match(agentAutomate.description, /Like agent_run, it always asks you before it places an order or pays, and the server enforces it; pass what your user explicitly approved \(not just asked for\) as purchase_approval\./);
    // agent_reply says the same as the server instructions: a checkout that matches the approval needs no second question to the user
    assert.match(
      agentReply.description,
      /to your user unless they already approved exactly that \(for a purchase: a checkout that matches what they approved, such as the job's purchase_approval\)\. Never send a password\./,
    );
  });

  test('the prompt: task and automation agents always ask before they order, also with a TASK that orders or a purchase approval; questions off never order', () => {
    const task = (extra: Partial<AgentInput> = {}) => KINDS.task.systemPrompt(newRun('task', extra), config);
    const user = (extra: Partial<AgentInput> = {}, cfg = config) => KINDS.task.userPrompt(newRun('task', extra), cfg);
    const rule =
      /\(1\) Before placing an order or paying, always ask first \(reason confirm\) with the item, the total price, the delivery address and the payment method\. A TASK that tells you to order or buy something still needs this confirmation: it only says what to buy\. Ask on the page that has the final order or payment button \(for example the order review page\), once it shows the total, the address and the payment method\. The server blocks that button until the host has answered a confirm question you asked on that same page\. If what you are about to do differs from what the host approved, ask again\./;
    const asks = task();
    assert.match(asks, rule);
    assert.doesNotMatch(asks, /maximum total and the checkout|explicitly says not to ask/, 'a price limit in the TASK is not an approval');
    // a purchase approval leaves rule (1) as it is (there is no "do not ask" variant any more)
    const approval = 'Approved: one Blue Mug, total up to $20, to my default address';
    assert.equal(task({ purchaseApproval: approval }), asks);
    assert.doesNotMatch(task({ confirmPurchases: false } as Partial<AgentInput>), /already approved purchases|do not need to ask/);
    assert.equal(task({ confirmPurchases: false } as Partial<AgentInput>), asks, 'confirm_purchases is gone');
    // the approval goes into the USER prompt as quoted data, after the TASK and before the saved sign-in
    assert.doesNotMatch(user(), /Purchase approval/);
    assert.equal(
      user({ purchaseApproval: approval }),
      'TASK:\nOrder one Blue Mug\n\nOUTPUT (exactly what to send back to the host):\nthe order number\n\n' +
        `Purchase approval from the user (the host checks your question against it): "${approval}". ` +
        'Still ask the host (reason confirm) on the checkout page before you place the order, and stay within this approval.',
    );
    assert.doesNotMatch(task({ purchaseApproval: approval }), new RegExp(approval.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')), 'never in the system prompt');
    const quoted = user({ purchaseApproval: `"Yes" ${'x'.repeat(600)}` });
    assert.match(quoted, /Purchase approval from the user \(the host checks your question against it\): "\\"Yes\\" x+…"\. Still ask/, 'quoted and capped');
    assert.ok(quoted.length < 800);

    const quiet = task({ allowQuestions: false });
    assert.match(
      quiet,
      /nobody can answer questions while you work\.\nNever place an order or pay: that needs the host's approval, nobody can give it while you work, and the server blocks the final order or payment button\. When the order is ready to be placed, call finish with success=false and say so/,
    );
    assert.equal(task({ allowQuestions: false, purchaseApproval: approval }), quiet);
    assert.match(
      user({ allowQuestions: false, purchaseApproval: approval }),
      /Purchase approval from the user: "Approved: one Blue Mug, total up to \$20, to my default address"\. You cannot ask the host in this job, so do not place the order: when it is ready and within this approval, call finish with success=false and say so\.$/,
    );
    // an automation agent follows the same rules: it always asks, a TASK that approves the purchase skips nothing,
    // and it never orders with questions off; its approval goes into its USER prompt too
    const auto = (extra: Partial<AgentInput> = {}) => KINDS.automation.systemPrompt(newRun('automation', extra), config);
    assert.match(auto(), rule);
    assert.doesNotMatch(auto(), /explicitly approves|says not to ask/);
    assert.equal(auto({ purchaseApproval: approval }), auto());
    assert.match(
      auto({ allowQuestions: false }),
      /nobody can answer questions while you work\.\nNever place an order or pay: that needs the host's approval, nobody can give it while you work, and the server blocks the final order or payment button\. When the order is ready to be placed, call finish with success=false and say so/,
    );
    assert.doesNotMatch(auto({ allowQuestions: false }), /explicitly approves/);
    assert.equal(
      KINDS.automation.userPrompt(newRun('automation', { purchaseApproval: approval, scriptName: 'mug-order' }), config),
      'TASK:\nOrder one Blue Mug\n\nOUTPUT (exactly what to send back to the host):\nthe order number\n\nSave the script under the name: mug-order\n\n' +
        `Purchase approval from the user (the host checks your question against it): "${approval}". ` +
        'Still ask the host (reason confirm) on the checkout page before you place the order, and stay within this approval.',
    );
    assert.doesNotMatch(KINDS.automation.userPrompt(newRun('automation'), config), /Purchase approval/);
    assert.doesNotMatch(KINDS.finder.systemPrompt(newRun('finder'), config), /place an order/i);
  });

  test('a sign-in question is secret by default only when it asks for a code; "which account" is not', async () => {
    const run = newRun();
    const env = { config, deps: { snapshots: null }, browser: { activeTab: null }, log: silent, forced: false, pause() {}, resume: async () => true, waitingCount: () => 0 } as any;
    const askHost = KINDS.task.tools(run, env).find((t) => t.name === 'ask_host')!;
    const cases: Array<[string, boolean | undefined, boolean]> = [
      ['Which account should I sign in with: personal or work?', undefined, false],
      ['What is the 6-digit verification code sent to your phone?', undefined, true],
      ['Which account: the one ending in 07?', true, true],
      ['Enter the one-time passcode from the app?', undefined, true],
    ];
    for (const [question, secret, expected] of cases) {
      run.step++;
      const pending = askHost.handler({ question, reason: 'sign_in', secret }, { markSensitive() {} } as any);
      assert.equal(run.question?.secret, expected, question);
      run.closeQuestion('answered', { answer: `answer-${run.step}`, by: null });
      await pending;
    }
    assert.equal(run.questions[0]!.answer, 'answer-1', 'the account choice is kept and shown');
    assert.equal(run.scrub('the personal account'), 'the personal account');
  });

  test('server instructions: purchases are always asked about; the host approves one its user approved in advance; without sub-agents the snapshot notes never point to agent_run', () => {
    const withAgents = serverInstructions(config);
    assert.match(
      withAgents,
      /\n- The agent always asks you before it places an order or pays, and the server enforces it\. When your user has explicitly approved the purchase \(in their request or earlier: "I approve", "go ahead and pay", "no need to ask me", or a maximum price\), pass their words as purchase_approval in agent_run or agent_automate, and approve the agent's matching confirm question yourself with agent_reply, without asking again\. A request to buy something \("order X and give me the order number"\) is not an approval: it says what to buy, not what it may cost\. Otherwise ask your user and answer with their decision\.\n/,
    );
    assert.match(withAgents, /to your user unless they already approved exactly that \(for a purchase: a checkout that matches what they approved\);/);
    assert.match(
      withAgents,
      /answer it now, or ask your user and answer when they reply \(the run waits up to 30 min\); never approve a purchase your user did not approve, and never send a code on your own \(reply "No" when nobody approved it\)\./,
    );
    assert.doesNotMatch(withAgents, /confirm_purchases|approve a purchase or send a code/);
    assert.doesNotMatch(withAgents, /Do not end your turn|approved up to \$30/);
    assert.match(withAgents, /pass its name to agent_run/);
    for (const env of [{}, { AGENT_LLM_URL: 'http://127.0.0.1:1/v1', TOOLSETS: 'core,snapshots' }]) {
      const text = serverInstructions(loadConfig(env));
      assert.match(text, /Snapshots are saved sign-ins/);
      assert.match(text, /load it into your browser with snapshot_load \{"name": "…"\}/);
      assert.doesNotMatch(text, /agent_run|sub-agent/i, JSON.stringify(env));
    }
    const quiet = serverInstructions(loadConfig({ AGENT_LLM_URL: 'http://127.0.0.1:1/v1', AGENT_MAX_QUESTIONS: '0' }));
    assert.match(
      quiet,
      /- agent_run and agent_automate agents never place an order or pay on this server: they would have to ask you first, and questions are off \(the server blocks the final order or payment button\)\. Such a job stops when the order is ready and says so\.\n/,
    );
    assert.doesNotMatch(quiet, /confirm_purchases|purchase_approval/);
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
