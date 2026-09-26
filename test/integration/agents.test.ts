import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFakeLlm, type FakeLlm, type FakeRequest, type FakeTurn } from '../helpers/fake-llm.ts';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';
import { connectClient, startTestServer, type TestServer } from '../helpers/harness.ts';

/**
 * Sub-agents end to end with a scripted model: the fake LLM decides each step, the real server
 * runs it in a real isolated Obscura browser against the fixture site. Needs a server we start
 * ourselves (the model endpoint is configured at startup), so it is skipped against MCP_URL.
 */
const SKIP = process.env.MCP_URL ? 'needs a server started with the fake model endpoint' : false;

type Policy = (req: FakeRequest) => FakeTurn;
const policies = new Map<string, Policy>();

/** Route each request to the policy of the test whose task marker appears in the conversation. */
function dispatch(req: FakeRequest): FakeTurn {
  const task = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  for (const [marker, policy] of policies) if (task.includes(marker)) return policy(req);
  return { content: 'no policy for this task' };
}

function call(name: string, args: Record<string, unknown>, reasoning = `I will call ${name}.`): FakeTurn {
  return { reasoning, toolCalls: [{ name, arguments: args }] };
}

describe('sub-agents (scripted model)', { skip: SKIP }, () => {
  let srv: TestServer;
  let site: FixtureServer;
  let llm: FakeLlm;
  let scriptsDir: string;
  let altBase: string;

  before(async () => {
    site = await startFixtureServer();
    // a second host name for the same fixture site, so the finder sees two different websites
    altBase = site.baseUrl.replace('127.0.0.1', 'localhost');
    llm = await startFakeLlm(dispatch);
    scriptsDir = mkdtempSync(path.join(tmpdir(), 'sbm-scripts-'));
    srv = await startTestServer({
      AGENT_LLM_URL: llm.url,
      AGENT_LLM_API_KEY: 'test-key',
      AGENT_LLM_MODEL: 'fake-model',
      AGENT_LLM_REASONING_EFFORT: 'medium',
      AGENT_CONTEXT_TOKENS: '65536',
      AGENT_WAIT_SECONDS: '120',
      AGENT_MAX_STEPS: '20',
      SCRIPTS_DIR: scriptsDir,
    });
  });

  after(async () => {
    await srv?.stop();
    await llm?.close();
    await site?.close();
  });

  test('the agent and script tools are listed, with the host browser tools', async () => {
    const { tools } = await srv.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['agent_run', 'agent_automate', 'agent_find', 'agent_wait', 'agent_status', 'agent_cancel', 'script_list', 'script_get', 'script_run', 'script_delete', 'browser_navigate', 'browser_snapshot']) {
      assert.ok(names.includes(n), `${n} is listed`);
    }
    const run = tools.find((t) => t.name === 'agent_run')!;
    assert.deepEqual((run.inputSchema as any).required?.sort(), ['output', 'task']);
  });

  test('agent_run completes a task in its own browser and returns the requested OUTPUT', async () => {
    const marker = 'MARKER-TASK-1';
    policies.set(marker, (req) => {
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: `${site.baseUrl}/catalog.html?q=red` });
        case 2:
          return call('browser_wait_for', { selector: '.product' });
        case 3:
          return call('browser_extract', { schema: { 'names[]': '.product .name', 'prices[]': '.product .price' } });
        case 4:
          // answers in plain text instead of calling finish: the runner must nudge it
          return { content: 'I have the products.' };
        default: {
          const extracted = [...req.messages].reverse().find((m) => m.role === 'tool' && String(m.content).includes('"names"'));
          const data = JSON.parse(extracted.content);
          return call('finish', { output: JSON.stringify(data.names), success: true, notes: 'from the catalog' });
        }
      }
    });
    // the host's own browser state must not be touched by the sub-agent
    await srv.call('browser_navigate', { url: `${site.baseUrl}/index.html` });
    const res = await srv.call('agent_run', {
      task: `${marker}: open the catalog, search for "red" and read the product names.`,
      output: 'A JSON array of the product names.',
      output_format: 'json',
    });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /completed — success/);
    const structured = res.raw.structuredContent;
    assert.deepEqual(structured.output, ['Red Apple Phone', 'Red Pear Laptop']);
    assert.equal(structured.status, 'completed');
    assert.match(structured.run_id, /^r[0-9a-f]{7}$/);

    // the main browser still shows the page the host opened
    const tabs = await srv.call('browser_tab_list');
    assert.match(tabs.text, /index\.html/);
    assert.doesNotMatch(tabs.text, /catalog/);

    // the model got the configured sampling settings, the key, streaming, and a nudge after the text answer
    const reqs = llm.requests.filter((r) => String(r.messages[1]?.content).includes(marker));
    const first = reqs[0].body;
    assert.equal(first.model, 'fake-model');
    assert.equal(first.temperature, 0.4);
    assert.equal(first.top_p, 0.95);
    assert.equal(first.reasoning_effort, 'medium');
    assert.equal(first.stream, true);
    assert.equal(reqs[0].headers.authorization, 'Bearer test-key');
    assert.ok(first.tools.some((t: any) => t.function.name === 'finish'));
    assert.ok(first.tools.some((t: any) => t.function.name === 'web_search'));
    assert.ok(!first.tools.some((t: any) => t.function.name.startsWith('agent_')), 'sub-agents cannot spawn sub-agents');
    const nudge = reqs[4].messages.at(-1);
    assert.equal(nudge.role, 'user');
    assert.match(nudge.content, /did not call a tool/);
    // reasoning is streamed back from the model but never sent to it again
    assert.ok(reqs.at(-1)!.messages.every((m: any) => m.reasoning === undefined));

    // logs: every sub-agent tool call is attributed to the run and its browser
    const runId = structured.run_id;
    const toolLogs = srv.logs().filter((l) => l.agentRunId === runId && l.component === 'tool');
    assert.ok(toolLogs.some((l) => l.tool === 'browser_navigate' && l.browserId === `agent-${runId}`));
    assert.ok(toolLogs.some((l) => l.tool === 'finish'));
    assert.ok(srv.logs().some((l) => l.component === 'agent-llm' && l.runId === runId && /model response/.test(l.msg)));

    // transcript on disk
    assert.ok(structured.transcript && existsSync(structured.transcript), 'transcript written');
    const transcript = JSON.parse(readFileSync(structured.transcript, 'utf8'));
    assert.equal(transcript.summary.id, runId);
    assert.ok(transcript.messages.length >= 10);
  });

  test('agent_find cross-checks two websites and returns the answer with cited links', async () => {
    const marker = 'MARKER-FIND-1';
    const a = `${site.baseUrl}/facts-a.html`;
    const b = `${altBase}/facts-b.html`;
    policies.set(marker, (req) => {
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: a });
        case 2:
          return call('browser_markdown', {});
        case 3:
          return call('cite_source', { url: a, quote: 'Project Zephyr was first released in 2019 by the Aurora Foundation.' });
        case 4:
          // too early: only one website so far
          return call('finish', { answer: '2019', confidence: 'high' });
        case 5:
          assert.match(req.lastToolResult ?? '', /only 1 website/);
          return call('cite_source', { url: b, quote: 'shipped in March 2019' });
        case 6:
          assert.match(req.lastToolResult ?? '', /was not opened in this job/);
          return call('browser_navigate', { url: b });
        case 7:
          return call('browser_markdown', {});
        case 8:
          return call('cite_source', { url: b, quote: 'Zephyr 1.0 shipped in March 2019.' });
        case 9:
          // text that only appears in the agent's own search query must not count as found on the page
          return call('browser_search', { query: 'Zephyr was released in 1999 on the moon' });
        case 10:
          return call('cite_source', { url: b, quote: 'Zephyr was released in 1999 on the moon' });
        case 11:
          return call('cite_source', { url: 'https://html.duckduckgo.com/html/?q=zephyr', quote: 'Zephyr' });
        case 12:
          assert.match(req.lastToolResult ?? '', /search results page is not a source/);
          return call('cite_source', { url: a, quote: 'released in 2021 by someone else' });
        default:
          return call('finish', { answer: 'Project Zephyr was first released in 2019 [1][2].', confidence: 'high', notes: 'Both sources agree.' });
      }
    });
    const res = await srv.call('agent_find', { objective: `${marker}: when was Project Zephyr first released?` });
    assert.equal(res.isError, false, res.text);
    const s = res.raw.structuredContent;
    assert.match(s.answer, /2019/);
    assert.equal(s.confidence, 'high');
    assert.equal(s.sources.length, 2);
    assert.equal(s.sources[0].url, a);
    assert.equal(s.sources[1].url, b);
    assert.equal(s.sources[0].quotes[0].verified, true);
    assert.equal(s.sources[1].quotes[0].verified, true);
    assert.equal(s.sources[0].quotes[1].verified, false, 'a quote that is not on the page is flagged');
    assert.equal(s.sources[1].quotes[1].verified, false, 'a phrase that only appears in a search query is not verified');
    assert.ok(!s.sources.some((src: any) => /duckduckgo/.test(src.url)), 'search result pages are not sources');
    assert.match(res.text, /SOURCES:/);
    assert.match(res.text, /\[1\] .*facts-a\.html/);
    assert.match(res.text, /\[2\] .*facts-b\.html/);
    // the finder's tools: search, reading and site search boxes, but no tabs, cookies or scripts
    const req = llm.requests.find((r) => String(r.messages[1]?.content).includes(marker))!;
    assert.ok(req.toolNames.includes('web_search'));
    assert.ok(req.toolNames.includes('cite_source'));
    assert.ok(req.toolNames.includes('browser_type'));
    assert.ok(!req.toolNames.includes('browser_tab_new'));
    assert.ok(!req.toolNames.includes('browser_evaluate'));
  });

  test('agent_automate records, verifies and stores a script that script_run replays without a model', async () => {
    const marker = 'MARKER-AUTO-1';
    const code = `async function run(params) {
  await browser.goto(${JSON.stringify(site.baseUrl)} + '/catalog.html?q=' + encodeURIComponent(params.query));
  await browser.waitFor('.product');
  const data = await browser.extract({ 'names[]': '.product .name', 'prices[]': '.product .price' });
  log('found', data.names.length, 'products');
  const count = await browser.count('.product');
  const first = await browser.attr('.product .name', 'href');
  const title = await browser.evaluate(() => document.title);
  const heading = await browser.evaluate('document.querySelector("h1").textContent');
  const sum = await browser.evaluate((a, b) => a + b, 2, 3);
  return {
    items: data.names.slice(0, params.limit).map((name, i) => ({ name, price: Number(data.prices[i].replace('$', '')) })),
    count, first, title, heading, sum,
  };
}`;
    policies.set(marker, (req) => {
      switch (req.step) {
        case 1:
          return call('browser_navigate', { url: `${site.baseUrl}/catalog.html?q=apple` });
        case 2:
          return call('browser_extract', { schema: { 'names[]': '.product .name' } });
        case 3:
          return call('finish', { output: 'x', verified: false });
        case 4:
          assert.match(req.lastToolResult ?? '', /no script saved/);
          return call('script_save', {
            name: 'Catalog Search!',
            description: 'Search the gadget catalog and return matching products.',
            params: [
              { name: 'query', type: 'string', description: 'Search text', example: 'apple' },
              { name: 'limit', type: 'integer', description: 'Maximum products', required: false, default: 10 },
            ],
            output_description: 'Object with items [{name, price}] and page details',
            code: 'async function run(params) { return [ }',
          });
        case 5:
          assert.match(req.lastToolResult ?? '', /does not compile/);
          return call('script_save', {
            name: 'catalog-search',
            description: 'Search the gadget catalog and return matching products.',
            params: [
              { name: 'query', type: 'string', description: 'Search text', example: 'apple' },
              { name: 'limit', type: 'integer', description: 'Maximum products', required: false, default: 10 },
            ],
            output_description: 'Object with items [{name, price}] and page details',
            code: '```js\n' + code + '\n```',
          });
        case 6:
          assert.match(req.lastToolResult ?? '', /Saved script "catalog-search" \(version 1\)/);
          return call('finish', { output: 'x', verified: true });
        case 7:
          assert.match(req.lastToolResult ?? '', /has not been tested/);
          return call('script_test', {});
        case 8:
          assert.match(req.lastToolResult ?? '', /RAN SUCCESSFULLY/);
          assert.match(req.lastToolResult ?? '', /Green Apple Watch/);
          return call('finish', {
            output: 'Red Apple Phone ($699), Green Apple Watch ($299)',
            verified: true,
            usage_notes: 'query is matched case-insensitively against product names.',
          });
        default:
          return { content: 'done' };
      }
    });
    const res = await srv.call('agent_automate', {
      task: `${marker}: search the gadget catalog for "apple" and list the products with prices.`,
      output: 'The matching products with their prices.',
    });
    assert.equal(res.isError, false, res.text);
    const s = res.raw.structuredContent;
    assert.equal(s.status, 'completed');
    assert.equal(s.success, true);
    assert.equal(s.script.name, 'catalog-search');
    assert.equal(s.script.version, 1);
    assert.equal(s.script.verification.status, 'passed');
    assert.deepEqual(s.script.run_with, { tool: 'script_run', arguments: { name: 'catalog-search', params: { query: 'apple', limit: 10 } } });
    assert.match(res.text, /Verification: PASSED/);
    assert.match(res.text, /- query \(string, required\): Search text Example: "apple"/);
    assert.match(res.text, /- limit \(integer, optional, default 10\)/);
    assert.match(res.text, /script_run \{"name":"catalog-search"/);
    assert.ok(existsSync(path.join(scriptsDir, 'catalog-search.js')));
    assert.ok(existsSync(path.join(scriptsDir, 'catalog-search.json')));

    // replay with other parameters, no model involved
    const before = llm.requests.length;
    const run = await srv.call('script_run', { name: 'catalog-search', params: { query: 'pear', limit: '1' } });
    assert.equal(run.isError, false, run.text);
    const out = run.raw.structuredContent.output;
    assert.deepEqual(out.items, [{ name: 'Blue Pear Tablet', price: 499 }]);
    assert.equal(out.count, 2);
    assert.match(out.first, /^http:\/\/.*catalog\.html\?q=pear#BluePearTablet$/, 'attr(href) is absolute');
    assert.equal(out.title, 'Gadget Catalog');
    assert.equal(out.heading, 'Gadget Catalog');
    assert.equal(out.sum, 5);
    assert.deepEqual(run.raw.structuredContent.logs.slice(0, 1), ['found 2 products']);
    assert.equal(llm.requests.length, before, 'script_run does not call the model');

    const missing = await srv.call('script_run', { name: 'catalog-search', params: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Missing required parameter\(s\): query/);
    const unknown = await srv.call('script_run', { name: 'catalog-search', params: { query: 'x', nope: 1 } });
    assert.match(unknown.text, /Unknown parameter\(s\): nope/);

    const list = await srv.call('script_list');
    assert.match(list.text, /catalog-search \(v1, verification passed, 1 run\)/);
    const got = await srv.call('script_get', { name: 'catalog-search' });
    assert.match(got.text, /async function run\(params\)/);
    assert.match(got.text, /Recorded for the task: MARKER-AUTO-1/);
  });

  test('a script that fails reports the error and its log; runaway scripts are stopped', async () => {
    const dir = scriptsDir;
    const { writeFileSync } = await import('node:fs');
    const meta = (name: string) => ({
      name,
      version: 1,
      description: 'test',
      params: [],
      output: { description: 'nothing' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      verification: { status: 'not_run', version: 1 },
      runs: 0,
    });
    writeFileSync(path.join(dir, 'broken.json'), JSON.stringify(meta('broken')));
    writeFileSync(path.join(dir, 'broken.js'), `async function run() { log('before'); await browser.goto(${JSON.stringify(site.baseUrl + '/index.html')}); throw new Error('element missing'); }`);
    const res = await srv.call('script_run', { name: 'broken' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Error: element missing/);
    assert.match(res.text, /Log:\nbefore/);

    writeFileSync(path.join(dir, 'escape.json'), JSON.stringify(meta('escape')));
    writeFileSync(
      path.join(dir, 'escape.js'),
      `async function run() { return { process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout, ctor: (() => { try { return typeof this.constructor.constructor('return process')(); } catch (e) { return 'blocked'; } })() }; }`,
    );
    const esc = await srv.call('script_run', { name: 'escape' });
    assert.equal(esc.isError, false, esc.text);
    const escaped = esc.raw.structuredContent.output;
    assert.deepEqual({ ...escaped, ctor: undefined }, { process: 'undefined', require: 'undefined', fetch: 'undefined', setTimeout: 'undefined', ctor: undefined });
    assert.ok(['undefined', 'blocked'].includes(escaped.ctor), 'the Function constructor cannot reach Node.js either');

    writeFileSync(path.join(dir, 'private.json'), JSON.stringify(meta('private')));
    writeFileSync(path.join(dir, 'private.js'), `async function run() { return await browser.goto('file:///etc/passwd'); }`);
    const priv = await srv.call('script_run', { name: 'private' });
    assert.equal(priv.isError, true);
    assert.match(priv.text, /scheme "file:" is not allowed/);

    const del = await srv.call('script_delete', { name: 'escape' });
    assert.match(del.text, /Deleted script escape/);
    const gone = await srv.call('script_get', { name: 'escape' });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /No script named "escape"/);
  });

  test('a slow run returns "still running", reports progress, and can be waited for or cancelled', async () => {
    const marker = 'MARKER-SLOW-1';
    policies.set(marker, (req) => {
      if (req.step === 1) return { ...call('browser_navigate', { url: `${site.baseUrl}/index.html` }), delayMs: 1_500 };
      if (req.step === 2) return { ...call('browser_snapshot', {}), delayMs: 1_500 };
      return { ...call('finish', { output: 'slow done' }), delayMs: 500 };
    });
    const progress: any[] = [];
    const raw: any = await srv.client.callTool(
      { name: 'agent_run', arguments: { task: `${marker}: open the index page.`, output: 'the word done', wait_seconds: 1 } },
      { onprogress: (p: any) => progress.push(p) } as any,
    );
    const text = raw.content.map((c: any) => c.text).join('\n');
    assert.match(text, /is still running/);
    const runId = raw.structuredContent.run_id;
    assert.match(text, new RegExp(`agent_wait with \\{"run_id": "${runId}"\\}`));
    assert.ok(progress.length >= 1, 'progress notifications were sent while waiting');
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress > progress[i - 1].progress, 'progress increases with every notification');

    const status = await srv.call('agent_status', {});
    assert.match(status.text, new RegExp(`${runId}\\s+task`));
    const done = await srv.call('agent_wait', { run_id: runId, wait_seconds: 60 });
    assert.match(done.text, /OUTPUT:\nslow done/);

    // cancel a run that would take long
    const marker2 = 'MARKER-SLOW-2';
    policies.set(marker2, () => ({ ...call('browser_wait', { seconds: 1 }), delayMs: 1_000 }));
    const started = await srv.call('agent_run', { task: `${marker2}: wait forever.`, output: 'nothing', wait_seconds: 0 });
    const id2 = started.raw.structuredContent.run_id;
    const cancelled = await srv.call('agent_cancel', { run_id: id2 });
    assert.match(cancelled.text, new RegExp(`Run ${id2} cancelled`));
    const after2 = await srv.call('agent_status', { run_id: id2 });
    assert.match(after2.text, /cancelled/);
  });

  test('a model endpoint error fails the run with a clear message; the dashboard lists agent browsers and runs', async () => {
    const marker = 'MARKER-ERR-1';
    policies.set(marker, () => ({ status: 401, error: 'invalid api key' }));
    const res = await srv.call('agent_run', { task: `${marker}: anything`, output: 'anything' });
    assert.equal(res.isError, true);
    assert.match(res.text, /failed/);
    assert.match(res.text, /rejected the API key \(HTTP 401\)/);

    const state = await (await fetch(`${srv.baseUrl}/api/state`)).json();
    assert.equal(state.agents.enabled, true);
    assert.ok(state.browsers.some((b: any) => b.kind === 'main'));
    assert.ok(state.browsers.some((b: any) => b.kind === 'agent' && b.status === 'closed'));
    assert.ok(state.browsers.some((b: any) => b.kind === 'script'));
    assert.ok(state.history.agents.length >= 3);
    const runId = res.raw.structuredContent.run_id;
    const details = await (await fetch(`${srv.baseUrl}/api/agents/${runId}`)).json();
    assert.equal(details.summary.status, 'failed');
    const scripts = await (await fetch(`${srv.baseUrl}/api/scripts`)).json();
    assert.ok(scripts.scripts.some((s: any) => s.name === 'catalog-search'));
    // watching an agent browser: its state, not the main browser's
    const agentBrowser = state.browsers.find((b: any) => b.kind === 'agent').id;
    const watched = await (await fetch(`${srv.baseUrl}/api/state?browser=${agentBrowser}`)).json();
    assert.equal(watched.watching, agentBrowser);
    assert.equal(watched.browser.closed, true);
  });

  test('a context window smaller than configured fails fast with advice instead of looping', async () => {
    const marker = 'MARKER-OVERFLOW-1';
    policies.set(marker, (req) =>
      req.step === 1
        ? call('browser_navigate', { url: `${site.baseUrl}/index.html` })
        : { status: 400, error: "This model's maximum context length is 70000 tokens. However, you requested 90000 tokens." },
    );
    const t0 = Date.now();
    const res = await srv.call('agent_run', { task: `${marker}: read the page`, output: 'anything' });
    assert.equal(res.isError, true);
    assert.match(res.text, /context window is smaller than this run needs/);
    assert.ok(Date.now() - t0 < 20_000, 'no busy loop until the time budget runs out');
    const requests = llm.requests.filter((r) => String(r.messages[1]?.content).includes(marker)).length;
    assert.ok(requests <= 5, `${requests} requests`);
  });

  test('script evaluate runs statement code exactly once and text() reads the page', async () => {
    const { writeFileSync } = await import('node:fs');
    const meta = { name: 'once', version: 1, description: 't', params: [], output: { description: 'o' }, createdAt: '2026-01-01', updatedAt: '2026-01-01', verification: { status: 'not_run', version: 1 }, runs: 0 };
    writeFileSync(path.join(scriptsDir, 'once.json'), JSON.stringify(meta));
    writeFileSync(
      path.join(scriptsDir, 'once.js'),
      `async function run() {
  await browser.goto(${JSON.stringify(site.baseUrl + '/facts-a.html')});
  const n = await browser.evaluate('window.__n = (window.__n || 0) + 1; return window.__n');
  const again = await browser.evaluate('window.__n');
  const text = await browser.text();
  const missing = await browser.text('h1');
  let clickError = null;
  try { await browser.clickText('no such button anywhere'); } catch (e) { clickError = e.message; }
  return { n, again, hasText: text.includes('Aurora Foundation'), missing, clickError };
}`,
    );
    const res = await srv.call('script_run', { name: 'once' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.raw.structuredContent.output, {
      n: 1,
      again: 1,
      hasText: true,
      missing: 'About Project Zephyr',
      clickError: 'browser.clickText: no clickable element with text "no such button anywhere"',
    });
  });

  test('malformed tool-call arguments do not break the conversation (strict endpoints like vLLM)', async () => {
    const marker = 'MARKER-BADARGS-1';
    policies.set(marker, (req) => {
      // like vLLM: every tool call in the history must carry valid JSON arguments
      for (const m of req.messages) for (const c of m.tool_calls ?? []) JSON.parse(c.function.arguments);
      if (req.step === 1) return { toolCalls: [{ name: 'browser_navigate', arguments: '{"url": "http://trunc' }] };
      assert.match(req.lastToolResult ?? '', /not valid JSON/);
      return call('finish', { output: 'recovered' });
    });
    const res = await srv.call('agent_run', { task: `${marker}: open a page`, output: 'the word recovered' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /OUTPUT:\nrecovered/);
  });

  test('sub-agent and script browsers run on their own engine: its crash does not reset the main browser', async () => {
    await srv.call('browser_navigate', { url: `${site.baseUrl}/index.html` });
    const health = await (await fetch(`${srv.baseUrl}/healthz`)).json();
    assert.ok(health.obscuraIsolated?.pid, 'a second engine runs');
    assert.notEqual(health.obscuraIsolated.pid, health.obscura.pid);
    process.kill(health.obscuraIsolated.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const tabs = await srv.call('browser_tab_list');
    assert.doesNotMatch(tabs.text, /connection was lost/, 'the main browser was not reset');
    assert.match(tabs.text, /index\.html/);
    // the second engine restarts and script runs work again
    let ran = null;
    for (let i = 0; i < 20 && !ran; i++) {
      const res = await srv.call('script_run', { name: 'once' });
      if (!res.isError) ran = res;
      else await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(ran, 'script runs recover after the engine restart');
  });

  test('a model that ignores tool_choice and answers the forced turn in text still gets its answer to the host', async () => {
    const marker = 'MARKER-FORCED-TEXT';
    policies.set(marker, (req) => {
      if (req.step === 1) return call('browser_navigate', { url: `${site.baseUrl}/index.html` });
      if (req.step === 3) assert.match(String(req.messages.at(-1)?.content), /Only finish is accepted now/);
      return { content: 'Final answer: the heading is Hello Fixture' };
    });
    const res = await srv.call('agent_run', { task: `${marker}: read the heading`, output: 'the heading', max_steps: 1 });
    const s = res.raw.structuredContent;
    assert.equal(s.status, 'completed', res.text);
    assert.equal(s.success, false);
    assert.equal(s.forced, true);
    assert.match(res.text, /No final result: the model did not call finish/);
    assert.match(res.text, /Final answer: the heading is Hello Fixture/);
    const reqs = llm.requests.filter((r) => String(r.messages[1]?.content).includes(marker));
    assert.ok(reqs.length <= 6, `${reqs.length} model requests`);
  });

  test('a second MCP client sees the same runs and scripts', async () => {
    const { client } = await connectClient(srv.mcpUrl, 'second-client');
    try {
      const res: any = await client.callTool({ name: 'script_list', arguments: {} });
      assert.match(res.content[0].text, /catalog-search/);
      const status: any = await client.callTool({ name: 'agent_status', arguments: {} });
      assert.match(status.content[0].text, /Recent agent runs/);
    } finally {
      await client.close();
    }
  });
});

describe('sub-agents disabled', { skip: SKIP }, () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-scripts-')) });
  });
  after(async () => {
    await srv?.stop();
  });

  test('without AGENT_LLM_URL the agent tools are hidden but scripts work', async () => {
    const names = (await srv.client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('agent_run'));
    assert.ok(names.includes('script_list'));
    const res = await srv.call('script_list');
    assert.match(res.text, /No scripts stored yet/);
  });
});

describe('sub-agent time budget', { skip: SKIP }, () => {
  let srv: TestServer;
  let site: FixtureServer;
  let llm: FakeLlm;
  before(async () => {
    site = await startFixtureServer();
    // slow model: every normal step takes 3 s; the run has 10 s, so the soft deadline hits mid-task
    llm = await startFakeLlm((req) => {
      const forced = typeof req.body.tool_choice === 'object';
      const slowFinish = String(req.messages[1]?.content).includes('SLOW-FINISH');
      if (forced && slowFinish) return { ...call('finish', { output: 'too late' }), delayMs: 8_000 };
      if (forced) return call('finish', { output: 'partial: the page title is Example', success: false, notes: 'ran out of time' });
      if (slowFinish && req.step === 1) return { ...call('note', { text: 'the index page title is Example' }), delayMs: 1_000 };
      return { ...call('browser_navigate', { url: `${site.baseUrl}/index.html` }), delayMs: 3_000 };
    });
    srv = await startTestServer({ AGENT_LLM_URL: llm.url, AGENT_MAX_RUNTIME_MS: '10000', AGENT_WAIT_SECONDS: '60', SCRIPTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-scripts-')) });
  });
  after(async () => {
    await srv?.stop();
    await llm?.close();
    await site?.close();
  });

  test('a run that runs out of time is made to report what it has, within its budget', async () => {
    const t0 = Date.now();
    const res = await srv.call('agent_run', { task: 'keep browsing forever', output: 'the page title' });
    const took = Date.now() - t0;
    assert.equal(res.raw.structuredContent.status, 'completed', res.text);
    assert.match(res.text, /partial: the page title is Example/);
    assert.match(res.text, /ran out of steps or time/);
    assert.ok(took < 14_000, `took ${took} ms`);
    const forced = llm.requests.find((r) => typeof r.body.tool_choice === 'object');
    assert.equal(forced?.body.tool_choice.function.name, 'finish');
    // the tool list stays the same as in earlier turns, so the endpoint can reuse its prompt cache
    assert.ok(forced!.toolNames.length > 1 && forced!.toolNames.includes('browser_navigate'));
  });

  test('when even the final turn runs out of time, the run reports the notes the agent saved', async () => {
    const res = await srv.call('agent_run', { task: 'SLOW-FINISH keep browsing forever', output: 'the page title' });
    const s = res.raw.structuredContent;
    assert.equal(s.status, 'completed', res.text);
    assert.equal(s.success, false);
    assert.equal(s.forced, true);
    assert.match(res.text, /No final result: the model did not finish within the time budget/);
    assert.match(res.text, /the index page title is Example/);
  });
});

describe('isolation with persisted cookies (OBSCURA_STORAGE_DIR)', { skip: SKIP }, () => {
  let srv: TestServer;
  let site: FixtureServer;
  let scriptsDir: string;
  before(async () => {
    site = await startFixtureServer();
    scriptsDir = mkdtempSync(path.join(tmpdir(), 'sbm-scripts-'));
    srv = await startTestServer({ OBSCURA_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-cookies-')), SCRIPTS_DIR: scriptsDir });
  });
  after(async () => {
    await srv?.stop();
    await site?.close();
  });

  test('script browsers run on a separate engine and never see the persisted cookies of the main browser', async () => {
    const { writeFileSync } = await import('node:fs');
    await srv.call('browser_navigate', { url: `${site.baseUrl}/set-cookie?name=host_login&value=keep-me-private` });
    const mine = await srv.call('browser_get_cookies');
    assert.match(mine.text, /host_login/);
    const meta = { name: 'peek', version: 1, description: 't', params: [], output: { description: 'o' }, createdAt: '2026-01-01', updatedAt: '2026-01-01', verification: { status: 'not_run', version: 1 }, runs: 0 };
    writeFileSync(path.join(scriptsDir, 'peek.json'), JSON.stringify(meta));
    writeFileSync(
      path.join(scriptsDir, 'peek.js'),
      `async function run() { await browser.goto(${JSON.stringify(site.baseUrl + '/set-cookie?name=script_cookie&value=from-script')}); return await browser.evaluate('document.cookie'); }`,
    );
    const res = await srv.call('script_run', { name: 'peek' });
    assert.equal(res.isError, false, res.text);
    const seen = String(res.raw.structuredContent.output);
    assert.doesNotMatch(seen, /host_login/, 'the script browser saw the host cookie');
    assert.match(seen, /script_cookie=from-script/);
    const after = await srv.call('browser_get_cookies');
    assert.doesNotMatch(after.text, /script_cookie/, 'a cookie from the script browser reached the main browser');
    assert.ok(srv.logs().some((l) => /separate engine without persisted cookies/.test(l.msg ?? '')));
  });
});
