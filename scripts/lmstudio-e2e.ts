/**
 * End-to-end checks with a real local model: LM Studio drives the Stealth
 * Browser MCP server through the same loop as scripts/lmstudio-agent.ts, and
 * every scenario is judged by objective assertions (answer text, requests the
 * fixture site received, the server's own activity feed).
 *
 *   node scripts/lmstudio-e2e.ts                  # scenarios a, b, d
 *   node scripts/lmstudio-e2e.ts --online         # also c (public JS-rendered site)
 *   node scripts/lmstudio-e2e.ts --only a --repeat 3
 *
 * Server: MCP_URL (or --mcp-url) when set; otherwise http://127.0.0.1:8931/mcp
 * if it is up; otherwise a local server is spawned (needs `npm run obscura:download`).
 * When the server runs in Docker, set FIXTURE_HOST=host.docker.internal and run the
 * container with ALLOW_PRIVATE_NETWORK=true so the browser can reach the fixture site.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { startFixtureServer, type FixtureServer } from '../test/helpers/fixture-server.ts';
import { startTestServer, type TestServer } from '../test/helpers/harness.ts';
import {
  AgentError,
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_MCP_URL,
  REASONING_MODES,
  connectMcp,
  resolveModel,
  runAgent,
  type AgentResult,
  type ReasoningMode,
} from './lmstudio-agent.ts';

const CLIENT_NAME = 'lmstudio-e2e';
const TYPING_TOOLS = ['browser_fill', 'browser_type', 'browser_fill_form', 'browser_evaluate'];

export interface ScenarioContext {
  fx: FixtureServer;
  result: AgentResult;
  /** Fixture requests received while the scenario ran. */
  requests: FixtureServer['requests'];
}

export interface Scenario {
  id: string;
  name: string;
  online?: boolean;
  maxSteps: number;
  task: (fx: FixtureServer) => string;
  /** Returns failure reasons (empty = pass). */
  check: (ctx: ScenarioContext) => string[];
  /** Reason the scenario cannot run against this server, if any. */
  unsupported?: (tools: string[]) => string | null;
}

const answerIncludes = (result: AgentResult, needle: string) => (result.finalAnswer ?? '').toLowerCase().includes(needle.toLowerCase());
/** "$2" or "$2.00", but not "$20" or "$2.50". */
const PEAR_PRICE = /\$\s?2(?:\.00?)?(?![\d.,]*\d)/;

export const SCENARIOS: Scenario[] = [
  {
    id: 'a',
    name: 'read page',
    maxSteps: 10,
    task: (fx) => `Open ${fx.baseUrl}/index.html and tell me the exact text of the h1 heading and the price of Pear.`,
    check: ({ result }) => {
      const failures: string[] = [];
      if (!answerIncludes(result, 'Hello Fixture')) failures.push('answer lacks "Hello Fixture"');
      if (!PEAR_PRICE.test(result.finalAnswer ?? '')) failures.push('answer lacks the price "$2"');
      if (!result.toolCalls.some((c) => c.name === 'browser_navigate' && !c.isError)) failures.push('browser_navigate was not used');
      return failures;
    },
  },
  {
    id: 'b',
    name: 'fill and submit form',
    maxSteps: 15,
    task: (fx) => `Go to ${fx.baseUrl}/form.html, fill the email field with e2e@example.com, check the "I agree" checkbox and submit the form.`,
    unsupported: (tools) =>
      TYPING_TOOLS.some((t) => tools.includes(t)) ? null : `the server offers no tool that can enter text (${TYPING_TOOLS.join(', ')})`,
    check: ({ requests }) => {
      const posts = requests.filter((r) => r.method === 'POST' && r.url.startsWith('/echo'));
      if (posts.length === 0) return ['the fixture site received no POST /echo (form was not submitted)'];
      const good = posts.find((r) => r.body.includes('email=e2e%40example.com') && /(^|&)agree=yes(&|$)/.test(r.body));
      if (good) return [];
      return [`POST /echo body did not contain email=e2e%40example.com and agree=yes: ${posts.map((p) => JSON.stringify(p.body)).join(' | ')}`];
    },
  },
  {
    id: 'c',
    name: 'JS-rendered site (online)',
    online: true,
    maxSteps: 12,
    task: () => 'Open https://quotes.toscrape.com/js/ and tell me who wrote the first quote.',
    check: ({ result }) => (answerIncludes(result, 'Albert Einstein') ? [] : ['answer lacks "Albert Einstein"']),
  },
];

export interface RunRecord {
  scenario: string;
  name: string;
  run: number;
  status: 'pass' | 'fail';
  steps: number;
  toolCalls: number;
  durationMs: number;
  failures: string[];
  tools: string[];
  answer: string | null;
  startedAt: string;
  result?: AgentResult;
}

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const style = (format: Parameters<typeof styleText>[0], text: string) => (color ? styleText(format, text, { validateStream: false }) : text);

function secondsText(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(fmt)].join('\n');
}

async function isHealthy(mcpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${mcpUrl.replace(/\/mcp\/?$/, '')}/healthz`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function authHeaders(): Record<string, string> {
  return process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
}

export interface ActivityCheck {
  failures: string[];
  verified: number;
  logged: number;
}

/** (d) The server's activity feed (and log tap) must contain every tool call the agent made. */
async function checkActivity(baseUrl: string, runs: RunRecord[]): Promise<ActivityCheck> {
  const res = await fetch(`${baseUrl}/api/state`, { headers: authHeaders() });
  if (!res.ok) return { failures: [`GET /api/state returned HTTP ${res.status}`], verified: 0, logged: 0 };
  return verifyActivity(await res.json(), runs);
}

/** Match the agent's tool calls against a GET /api/state body. */
export function verifyActivity(state: any, runs: RunRecord[]): ActivityCheck {
  // Only the agent's own session: the preflight client ("lmstudio-e2e-preflight") opens the same
  // fixture page just before scenario a and must not stand in for a call the agent made.
  const activity: any[] = (state.history?.activity ?? []).filter(
    (a: any) => typeof a.client === 'string' && (a.client === CLIENT_NAME || a.client.startsWith(`${CLIENT_NAME} `)),
  );
  const logs: any[] = state.history?.logs ?? [];
  const oldestLog = logs.length ? Date.parse(logs[0].time) : Infinity;
  const used = new Set<string>();
  const failures: string[] = [];
  let verified = 0;
  let logged = 0;

  for (const run of runs) {
    const since = Date.parse(run.startedAt);
    for (const call of run.result?.toolCalls ?? []) {
      // Calls rejected by the SDK's input-schema validation never reach the tool runner, so they have no activity entry.
      if (!call.executed || (call.isError && /Input validation error/.test(call.result))) continue;
      const match = activity.find(
        (a) =>
          !used.has(a.id) &&
          a.tool === call.name &&
          Date.parse(a.startedAt) >= since - 1_000 &&
          (call.name !== 'browser_navigate' || (a.args as any)?.url === (call.args as any)?.url),
      );
      if (!match) {
        failures.push(`scenario ${run.scenario} run ${run.run}: ${call.name} ${JSON.stringify(call.args)} is missing from the server activity feed`);
        continue;
      }
      used.add(match.id);
      verified++;
      if (match.status !== (call.isError ? 'error' : 'ok')) {
        failures.push(`scenario ${run.scenario} run ${run.run}: ${call.name} recorded as "${match.status}" but the client saw ${call.isError ? 'an error' : 'success'}`);
      }
      if (Date.parse(match.startedAt) >= oldestLog + 1_000) {
        const hasLog = logs.some((l) => l.callId === match.id && typeof l.msg === 'string' && l.msg.startsWith(`tool call ${call.name}`));
        if (hasLog) logged++;
        else failures.push(`scenario ${run.scenario} run ${run.run}: no "tool call ${call.name}" log record for call ${match.id}`);
      }
    }
  }
  if (verified === 0 && failures.length === 0) failures.push('no tool calls to verify (run at least one other scenario)');
  return { failures, verified, logged };
}

const USAGE = `Usage: node scripts/lmstudio-e2e.ts [options]

Options:
  --only <a,b,c,d>       scenarios to run (default: a,b,d; c needs --online)
  --online               include scenarios that need the internet (c)
  --repeat <n>           run each model scenario n times (default 1)
  --model <id>           LM Studio model (default: LMSTUDIO_MODEL or the first loaded tool-use LLM)
  --reasoning <mode>     none | low | medium | high | on (default low)
  --max-steps <n>        override the per-scenario step limit
  --mcp-url <url>        MCP endpoint (default MCP_URL, else ${DEFAULT_MCP_URL} if up, else spawn a local server)
  --spawn                always spawn a local server for the run
  --quiet                only print the summary
  --json <file>          write results (with transcripts) as JSON
  -h, --help

Environment: MCP_URL, AUTH_TOKEN, LMSTUDIO_URL, LM_API_TOKEN, LMSTUDIO_MODEL, FIXTURE_HOST.`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        only: { type: 'string' },
        online: { type: 'boolean' },
        repeat: { type: 'string' },
        model: { type: 'string' },
        reasoning: { type: 'string' },
        'max-steps': { type: 'string' },
        'mcp-url': { type: 'string' },
        spawn: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        json: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const only = values.only?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = ['a', 'b', 'c', 'd'];
  const badIds = (only ?? []).filter((id) => !known.includes(id));
  const reasoning = values.reasoning as ReasoningMode | undefined;
  const repeat = Number(values.repeat ?? 1);
  const maxStepsOverride = values['max-steps'] ? Number(values['max-steps']) : undefined;
  if (badIds.length || (reasoning && !REASONING_MODES.includes(reasoning)) || !Number.isInteger(repeat) || repeat < 1 || (maxStepsOverride !== undefined && !(maxStepsOverride >= 1))) {
    console.error(`Invalid options.\n\n${USAGE}`);
    return 2;
  }
  const wanted = (id: string) => (only ? only.includes(id) : id !== 'c' || Boolean(values.online));
  if (only?.includes('c') && !values.online) console.log(style('yellow', 'Note: scenario c needs internet access; running it because it was requested with --only.'));
  const scenarios = SCENARIOS.filter((s) => wanted(s.id));
  const wantActivity = wanted('d');

  const lmstudioUrl = process.env.LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL;
  const lmApiToken = process.env.LM_API_TOKEN;
  const model = await resolveModel(lmstudioUrl, lmApiToken, values.model ?? process.env.LMSTUDIO_MODEL);

  let spawned: TestServer | null = null;
  let mcpUrl = values['mcp-url'] ?? process.env.MCP_URL;
  if (values.spawn || (!mcpUrl && !(await isHealthy(DEFAULT_MCP_URL)))) {
    console.log(style('dim', 'Starting a local Stealth Browser MCP server for this run...'));
    const saved = process.env.MCP_URL;
    delete process.env.MCP_URL;
    try {
      spawned = await startTestServer({ LOG_LEVEL: 'warn' });
    } finally {
      if (saved !== undefined) process.env.MCP_URL = saved;
    }
    mcpUrl = spawned.mcpUrl;
  }
  mcpUrl ??= DEFAULT_MCP_URL;
  if (!spawned && !(await isHealthy(mcpUrl))) {
    console.error(`The MCP server at ${mcpUrl} is not reachable (GET /healthz failed). Start it, fix MCP_URL, or pass --spawn.`);
    return 1;
  }
  const baseUrl = mcpUrl.replace(/\/mcp\/?$/, '');
  const fx = await startFixtureServer();
  const runs: RunRecord[] = [];
  let activityResult: ActivityCheck | null = null;
  const suiteStarted = Date.now();

  try {
    // Preflight without the model: the browser must reach the fixture site.
    const pre = await connectMcp(mcpUrl, process.env.AUTH_TOKEN, `${CLIENT_NAME}-preflight`);
    let tools: string[];
    try {
      tools = (await pre.client.listTools()).tools.map((t) => t.name);
      const nav: any = await pre.client.callTool({ name: 'browser_navigate', arguments: { url: `${fx.baseUrl}/index.html` } });
      if (nav.isError) {
        const text = (nav.content ?? []).map((c: any) => c.text ?? '').join(' ');
        throw new AgentError(
          `Preflight failed: the browser cannot open the fixture site ${fx.baseUrl} (${text}). ` +
            'Run the server with ALLOW_PRIVATE_NETWORK=true, and when it runs in Docker set FIXTURE_HOST=host.docker.internal.',
        );
      }
    } finally {
      await pre.transport.terminateSession().catch(() => undefined);
      await pre.client.close().catch(() => undefined);
    }

    console.log(
      `${style('bold', 'LM Studio E2E')} ${style('dim', `| model ${model.id} | reasoning ${reasoning ?? 'low'} | MCP ${mcpUrl}${spawned ? ' (spawned)' : ''} | fixture ${fx.baseUrl} | ${tools.length} tools`)}`,
    );

    for (const scenario of scenarios) {
      for (let run = 1; run <= repeat; run++) {
        const label = `${scenario.id}${repeat > 1 ? `#${run}` : ''}`;
        const startedAt = new Date().toISOString();
        const unsupported = scenario.unsupported?.(tools) ?? null;
        if (unsupported) {
          runs.push({ scenario: scenario.id, name: scenario.name, run, status: 'fail', steps: 0, toolCalls: 0, durationMs: 0, failures: [`cannot run: ${unsupported}`], tools: [], answer: null, startedAt });
          console.log(style('red', `\n=== ${label} ${scenario.name}: cannot run (${unsupported})`));
          continue;
        }
        if (!values.quiet) console.log(style(['bold', 'cyan'], `\n=== scenario ${label}: ${scenario.name}`));
        const requestMark = fx.requests.length;
        const indent = (text: string) =>
          text
            .split('\n')
            .map((line) => `  | ${line}`.trimEnd())
            .join('\n');
        let pending = '';
        const result = await runAgent({
          task: scenario.task(fx),
          mcpUrl,
          authToken: process.env.AUTH_TOKEN,
          lmstudioUrl,
          lmApiToken,
          model: model.id,
          reasoning,
          maxSteps: maxStepsOverride ?? scenario.maxSteps,
          clientName: CLIENT_NAME,
          quiet: values.quiet,
          color,
          write: (text) => {
            if (values.quiet) return;
            pending += text;
            const cut = pending.lastIndexOf('\n');
            if (cut < 0) return;
            process.stdout.write(`${indent(pending.slice(0, cut))}\n`);
            pending = pending.slice(cut + 1);
          },
          signal: AbortSignal.timeout(15 * 60_000),
        });
        if (pending && !values.quiet) process.stdout.write(`${indent(pending)}\n`);
        const failures = [
          ...(result.ok ? [] : [`agent stopped: ${result.stopReason}${result.error ? ` (${result.error.split('\n')[0]})` : ''}`]),
          ...scenario.check({ fx, result, requests: fx.requests.slice(requestMark) }),
        ];
        const record: RunRecord = {
          scenario: scenario.id,
          name: scenario.name,
          run,
          status: failures.length ? 'fail' : 'pass',
          steps: result.steps,
          toolCalls: result.toolCalls.length,
          durationMs: result.durationMs,
          failures,
          tools: result.toolCalls.map((c) => c.name),
          answer: result.finalAnswer,
          startedAt,
          result,
        };
        runs.push(record);
        console.log(
          `${record.status === 'pass' ? style(['bold', 'green'], 'PASS') : style(['bold', 'red'], 'FAIL')} ${label} ${scenario.name} ` +
            style('dim', `(${record.steps} steps, ${record.toolCalls} tool calls, ${secondsText(record.durationMs)})`),
        );
        for (const f of failures) console.log(style('red', `  - ${f}`));
      }
    }

    if (wantActivity) {
      activityResult = await checkActivity(baseUrl, runs);
      const ok = activityResult.failures.length === 0;
      console.log(
        `\n${ok ? style(['bold', 'green'], 'PASS') : style(['bold', 'red'], 'FAIL')} d server activity feed ` +
          style('dim', `(${activityResult.verified} tool calls found in /api/state, ${activityResult.logged} matched log records)`),
      );
      for (const f of activityResult.failures) console.log(style('red', `  - ${f}`));
    }
  } finally {
    await fx.close();
    await spawned?.stop();
  }

  const rows = [['scenario', 'result', 'steps', 'tool calls', 'duration', 'tools used']];
  for (const r of runs) {
    rows.push([`${r.scenario}${repeat > 1 ? `#${r.run}` : ''} ${r.name}`, r.status.toUpperCase(), String(r.steps), String(r.toolCalls), secondsText(r.durationMs), [...new Set(r.tools)].join(', ')]);
  }
  if (activityResult) {
    rows.push(['d server activity feed', activityResult.failures.length ? 'FAIL' : 'PASS', '-', String(activityResult.verified), '-', `${activityResult.logged} log records matched`]);
  }
  console.log(`\n${table(rows)}\n`);
  const failed = runs.filter((r) => r.status === 'fail').length + (activityResult?.failures.length ? 1 : 0);
  console.log(
    failed
      ? style(['bold', 'red'], `${failed} check(s) failed`)
      : style(['bold', 'green'], `All ${runs.length + (activityResult ? 1 : 0)} checks passed`) + style('dim', ` in ${secondsText(Date.now() - suiteStarted)}`),
  );

  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ model: model.id, mcpUrl, reasoning: reasoning ?? 'low', runs, activity: activityResult }, null, 2)}\n`);
    console.log(`Results written to ${values.json}`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof AgentError ? `Error: ${err.message}` : `fatal: ${(err as Error)?.stack ?? err}`);
      process.exit(1);
    },
  );
}
