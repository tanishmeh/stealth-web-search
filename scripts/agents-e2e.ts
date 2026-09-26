/**
 * Live end-to-end checks of the sub-agents with the configured model (AGENT_LLM_URL on the server).
 * Each scenario hands a job to a sub-agent through MCP, exactly like a host agent would, and judges
 * the result against ground truth that this script reads itself with the regular browser tools.
 *
 *   node scripts/agents-e2e.ts                         # all scenarios against http://127.0.0.1:8931/mcp
 *   node scripts/agents-e2e.ts --only automate --repeat 3
 *   MCP_URL=http://127.0.0.1:8931/mcp AUTH_TOKEN=... node scripts/agents-e2e.ts --json results.json
 *
 * Scenarios (public sites made for scraping practice, so the ground truth is stable):
 *   run       agent_run: first 3 books of a books.toscrape.com category as JSON
 *   automate  agent_automate: a "quotes by tag" script, then script_run with other parameters
 *   find      agent_find: a fact confirmed on at least two websites, with cited links
 *   parallel  agent_run and agent_find at the same time (separate browsers)
 * Every scenario also checks that the host's own browser was not touched.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const USAGE = `Usage: node scripts/agents-e2e.ts [--only run,automate,find,parallel] [--repeat N] [--mcp-url URL] [--json FILE]`;

interface Outcome {
  scenario: string;
  attempt: number;
  pass: boolean;
  failures: string[];
  durationMs: number;
  runs: Array<{ runId: string; kind: string; status: string; steps: number; durationMs: number; tokens?: unknown }>;
  details?: unknown;
}

type Call = (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<{ text: string; structured: any; isError: boolean }>;

const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[“”‘’"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

async function groundTruth(call: Call, url: string, schema: Record<string, string>): Promise<Record<string, string[]>> {
  const nav = await call('browser_navigate', { url });
  if (nav.isError) throw new Error(`ground truth: ${nav.text}`);
  const res = await call('browser_extract', { schema });
  if (res.isError) throw new Error(`ground truth: ${res.text}`);
  return JSON.parse(res.text);
}

/** The shared browser's tab list, to check that sub-agents never touch it. */
async function hostTabs(call: Call): Promise<string> {
  return (await call('browser_tab_list', {})).text;
}

async function mainBrowserUntouched(call: Call, before: string): Promise<string[]> {
  const after = await hostTabs(call);
  return after === before ? [] : [`the host browser changed during the run:\n      before: ${before.replace(/\n/g, ' | ')}\n      after:  ${after.replace(/\n/g, ' | ')}`];
}

const SCENARIOS: Record<string, (call: Call) => Promise<{ failures: string[]; runs: Outcome['runs']; details?: unknown }>> = {
  async run(call) {
    const category = 'https://books.toscrape.com/catalogue/category/books/poetry_23/index.html';
    const truth = await groundTruth(call, category, { 'titles[]': 'article.product_pod h3 a@title', 'prices[]': 'article.product_pod .price_color' });
    await call('browser_navigate', { url: 'https://example.com/' });
    const before = await hostTabs(call);
    const res = await call('agent_run', {
      task: 'On https://books.toscrape.com, open the "Poetry" category (from the category list on the left) and read the first 3 books listed there.',
      output: 'A JSON array of 3 objects {title, price}: the full book title (the link title attribute, not the shortened text) and the price exactly as shown, e.g. "£51.77".',
      output_format: 'json',
      wait_seconds: 900,
    });
    const failures: string[] = [];
    const out = res.structured?.output;
    if (res.isError || !Array.isArray(out)) failures.push(`no JSON array output: ${res.text.slice(0, 400)}`);
    else {
      if (out.length !== 3) failures.push(`expected 3 books, got ${out.length}`);
      out.slice(0, 3).forEach((b: any, i: number) => {
        if (norm(b?.title) !== norm(truth.titles[i])) failures.push(`book ${i + 1} title ${JSON.stringify(b?.title)} != ${JSON.stringify(truth.titles[i])}`);
        if (norm(b?.price) !== norm(truth.prices[i])) failures.push(`book ${i + 1} price ${JSON.stringify(b?.price)} != ${JSON.stringify(truth.prices[i])}`);
      });
    }
    failures.push(...(await mainBrowserUntouched(call, before)));
    return { failures, runs: [runInfo(res.structured)], details: { output: out, truth } };
  },

  async automate(call) {
    await call('browser_navigate', { url: 'https://example.com/' });
    const before = await hostTabs(call);
    const res = await call('agent_automate', {
      task: 'On https://quotes.toscrape.com, get the first 3 quotes for the tag "love" (tag pages are at /tag/<tag>/): the quote text and its author.',
      output: 'A JSON array of {text, author} objects in page order; text without the surrounding quotation marks.',
      parameters: 'the tag, and how many quotes to return',
      script_name: 'e2e-quotes-by-tag',
      overwrite: true,
      wait_seconds: 1200,
    });
    const failures: string[] = [];
    const script = res.structured?.script;
    if (res.isError || !script) {
      failures.push(`no script: ${res.text.slice(0, 600)}`);
      return { failures, runs: [runInfo(res.structured)] };
    }
    if (script.verification?.status !== 'passed') failures.push(`verification ${script.verification?.status}: ${script.verification?.error ?? ''}`);
    const params: any[] = script.params ?? [];
    const tagParam = params.find((p) => p.type === 'string');
    const countParam = params.find((p) => p.type === 'integer' || p.type === 'number');
    if (!tagParam) failures.push(`no string parameter for the tag: ${JSON.stringify(params)}`);
    if (!countParam) failures.push(`no number parameter for the count: ${JSON.stringify(params)}`);
    if (failures.length) return { failures, runs: [runInfo(res.structured)], details: { script } };

    failures.push(...(await mainBrowserUntouched(call, before)));
    // replay with new parameters, no model involved
    const replay = await call('script_run', { name: script.name, params: { [tagParam.name]: 'life', [countParam.name]: 2 } });
    const truth = await groundTruth(call, 'https://quotes.toscrape.com/tag/life/', { 'texts[]': '.quote .text', 'authors[]': '.quote .author' });
    const out = replay.structured?.output;
    if (replay.isError || !Array.isArray(out)) failures.push(`script_run failed: ${replay.text.slice(0, 600)}`);
    else {
      if (out.length !== 2) failures.push(`script_run returned ${out.length} quotes, expected 2`);
      out.slice(0, 2).forEach((q: any, i: number) => {
        if (norm(q?.author) !== norm(truth.authors[i])) failures.push(`quote ${i + 1} author ${JSON.stringify(q?.author)} != ${JSON.stringify(truth.authors[i])}`);
        if (norm(q?.text) !== norm(truth.texts[i])) failures.push(`quote ${i + 1} text differs: ${JSON.stringify(String(q?.text).slice(0, 80))}`);
      });
    }
    return { failures, runs: [runInfo(res.structured)], details: { script: { name: script.name, params, verification: script.verification }, replay: out } };
  },

  async find(call) {
    await call('browser_navigate', { url: 'https://example.com/' });
    const before = await hostTabs(call);
    const res = await call('agent_find', { objective: 'In which year was the Python programming language first released?', output: 'The year, with one sentence of context.', wait_seconds: 900 });
    const failures = checkFind(res, /1991/);
    failures.push(...(await mainBrowserUntouched(call, before)));
    return { failures, runs: [runInfo(res.structured)], details: { answer: res.structured?.answer, sources: res.structured?.sources } };
  },

  async parallel(call) {
    await call('browser_navigate', { url: 'https://example.com/' });
    const before = await hostTabs(call);
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      call('agent_run', {
        task: 'Open https://quotes.toscrape.com/ and read the author of the first quote on the page.',
        output: 'Only the author name.',
        wait_seconds: 900,
      }),
      call('agent_find', { objective: 'What is the chemical symbol of the element tungsten?', output: 'The symbol only, then one sentence of context.', wait_seconds: 900 }),
    ]);
    const failures: string[] = [];
    if (!/einstein/i.test(String(a.structured?.output ?? ''))) failures.push(`agent_run: expected Albert Einstein, got ${JSON.stringify(a.structured?.output ?? a.text.slice(0, 300))}`);
    failures.push(...checkFind(b, /\bW\b/).map((f) => `agent_find: ${f}`));
    if (a.structured?.run_id && b.structured?.run_id) {
      const status = await call('agent_status', {});
      const runs: any[] = status.structured?.runs ?? [];
      const ra = runs.find((r) => r.id === a.structured.run_id);
      const rb = runs.find((r) => r.id === b.structured.run_id);
      if (ra && rb) {
        const overlap = Math.min(Date.parse(ra.endedAt), Date.parse(rb.endedAt)) - Math.max(Date.parse(ra.startedAt), Date.parse(rb.startedAt));
        if (!(overlap > 0)) failures.push('the two runs did not overlap in time (they should run concurrently)');
        if (ra.browserId === rb.browserId) failures.push('the two runs shared a browser');
      }
    }
    failures.push(...(await mainBrowserUntouched(call, before)));
    return { failures, runs: [runInfo(a.structured), runInfo(b.structured)], details: { wallMs: Date.now() - t0, a: a.structured?.output, b: b.structured?.answer } };
  },
};

function checkFind(res: { text: string; structured: any; isError: boolean }, answer: RegExp): string[] {
  const failures: string[] = [];
  const s = res.structured ?? {};
  if (res.isError) failures.push(`failed: ${res.text.slice(0, 500)}`);
  if (!answer.test(String(s.answer ?? ''))) failures.push(`answer does not match ${answer}: ${JSON.stringify(String(s.answer ?? '').slice(0, 300))}`);
  const sources: any[] = s.sources ?? [];
  const sites = new Set(sources.map((src) => { try { return new URL(src.url).hostname.replace(/^www\./, ''); } catch { return src.url; } }));
  if (sites.size < 2) failures.push(`expected sources on at least 2 websites, got ${[...sites].join(', ') || 'none'}`);
  if (!sources.some((src) => (src.quotes ?? []).some((q: any) => q.verified))) failures.push('no cited quote was verified on its page');
  if (!sources.every((src) => /^https?:\/\//.test(src.url))) failures.push('a source has no http(s) URL');
  return failures;
}

function runInfo(s: any): Outcome['runs'][number] {
  return { runId: s?.run_id ?? '?', kind: s?.kind ?? '?', status: s?.status ?? '?', steps: s?.steps ?? 0, durationMs: s?.duration_ms ?? 0 };
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        only: { type: 'string' },
        repeat: { type: 'string' },
        'mcp-url': { type: 'string' },
        json: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const mcpUrl = values['mcp-url'] ?? process.env.MCP_URL ?? 'http://127.0.0.1:8931/mcp';
  const only = values.only ? values.only.split(',').map((s) => s.trim()) : Object.keys(SCENARIOS);
  const unknown = only.filter((s) => !SCENARIOS[s]);
  if (unknown.length) {
    console.error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
    return 2;
  }
  const repeat = Math.max(1, Number(values.repeat ?? 1));
  const headers: Record<string, string> = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
  const client = new Client({ name: 'agents-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  if (!tools.includes('agent_run')) {
    console.error(`${mcpUrl} does not offer agent_run: set AGENT_LLM_URL on the server, and include the agents and scripts groups if you set TOOLSETS (see docs/AGENTS.md).`);
    await client.close();
    return 2;
  }
  const call: Call = async (name, args, timeoutMs = 1_500_000) => {
    const raw: any = await client.callTool({ name, arguments: args }, { timeout: timeoutMs, resetTimeoutOnProgress: true } as any);
    const text = (raw.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return { text, structured: raw.structuredContent ?? null, isError: Boolean(raw.isError) };
  };

  const outcomes: Outcome[] = [];
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const id of only) {
      const t0 = Date.now();
      process.stdout.write(`${styleText('bold', `[${id}]`)}${repeat > 1 ? ` #${attempt}` : ''} … `);
      let outcome: Outcome;
      try {
        const r = await SCENARIOS[id](call);
        outcome = { scenario: id, attempt, pass: r.failures.length === 0, failures: r.failures, durationMs: Date.now() - t0, runs: r.runs, details: r.details };
      } catch (err) {
        outcome = { scenario: id, attempt, pass: false, failures: [`crashed: ${(err as Error).message}`], durationMs: Date.now() - t0, runs: [] };
      }
      outcomes.push(outcome);
      const runs = outcome.runs.map((r) => `${r.runId} ${r.kind} ${r.status} ${r.steps} steps ${(r.durationMs / 1000).toFixed(1)} s`).join('; ');
      console.log(`${outcome.pass ? styleText('green', 'PASS') : styleText('red', 'FAIL')} (${(outcome.durationMs / 1000).toFixed(1)} s) ${runs}`);
      for (const f of outcome.failures) console.log(`    - ${f}`);
    }
  }
  await client.close();
  const passed = outcomes.filter((o) => o.pass).length;
  console.log(`\n${passed}/${outcomes.length} passed`);
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ mcpUrl, at: new Date().toISOString(), outcomes }, null, 2)}\n`);
  return passed === outcomes.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`agents-e2e: ${(err as Error).stack ?? err}`);
    process.exit(1);
  },
);
