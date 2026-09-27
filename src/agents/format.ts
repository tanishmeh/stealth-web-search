import type { ScriptMeta, ScriptParam } from '../scripts/store.ts';
import { exampleParams } from '../scripts/store.ts';
import type { AgentQuestion, AgentRun, QuestionReason, SnapshotSaved } from './run.ts';

/** How agent runs are reported to the host agent: readable text plus structured content. */

export function seconds(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 100) / 10)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

/** A whole number of minutes (or seconds, under a minute), e.g. "30 min". */
export function durationText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

const KIND_NAME = { task: 'agentic', automation: 'automation', finder: 'finder' } as const;

/** What the host must weigh before it answers, by the kind of question (confirm: confirmHint). */
const REASON_HINT: Partial<Record<QuestionReason, string>> = {
  sign_in: 'Tell your user which site asks (see "asked on"); never send a password; do not relay a code for a site the task did not name.',
};

/**
 * A confirm question of a task or automation agent (the purchase guard keeps the order button blocked
 * until it is answered): the host approves it itself when it matches what the user approved in advance
 * (purchase_approval), and asks its user otherwise.
 */
function confirmHint(run: AgentRun): string {
  const approval = run.input.purchaseApproval;
  const decide = approval
    ? `Your user approved in advance (purchase_approval): ${JSON.stringify(approval)}. ` +
      'Approve it yourself now with agent_reply, without asking your user, only if those words are your user\'s explicit approval ("I approve", "go ahead", a maximum price), not just their request to buy, ' +
      'and this checkout matches them (item, quantity, total within the limit, address, payment method). Otherwise ask your user and answer with their decision.'
    : 'Ask your user to approve it, then answer with agent_reply. If your user already approved exactly this earlier in your conversation, approve it yourself.';
  return `This asks you to approve a step that cannot be undone. ${decide}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line JSON for tool hints, spaced like the other hints: {"run_id": "r1", "answer": "..."}. */
export function inlineJson(value: Record<string, unknown>): string {
  return `{${Object.entries(value)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ')}}`;
}

/** agent_reply arguments for a question (with "secret": true when the answer is a code or other secret). */
export function replyArguments(run: AgentRun, q: AgentQuestion, answer: string): Record<string, unknown> {
  return { run_id: run.id, question_id: q.id, answer, ...(q.secret ? { secret: true } : {}) };
}

function waitingResult(run: AgentRun, q: AgentQuestion, base: Record<string, unknown>): { text: string; structured: Record<string, unknown>; isError: boolean } {
  const lines = [`Run ${run.id} is waiting for your answer (question ${q.id}, asked on ${q.origin ?? 'no web page'}):`, '', q.text];
  if (q.options.length) lines.push('', `Options: ${q.options.join(' | ')}`);
  const hint = [
    q.reason === 'confirm' ? confirmHint(run) : REASON_HINT[q.reason],
    q.secret ? 'Send only the code or secret itself as the answer, e.g. "482913", not a sentence.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (hint) lines.push('', hint);
  const left = Math.max(0, Date.parse(q.expiresAt) - Date.now());
  // a chat host asks its user by ending its turn: that is allowed, answering for the user is not
  lines.push(
    '',
    `The run is paused and keeps its browser. Answer with agent_reply ${inlineJson(replyArguments(run, q, '...'))}`,
    `Answer it now, or ask your user and answer when they reply (the run waits up to ${durationText(left)}, then continues without an answer; agent_cancel stops it). ` +
      'Never approve a purchase your user did not approve, and never send a code on your own.',
  );
  return {
    text: lines.join('\n'),
    structured: {
      ...base,
      status: 'waiting',
      activity: run.activity,
      question: {
        id: q.id,
        text: q.text,
        options: q.options,
        reason: q.reason,
        secret: q.secret,
        page_url: q.pageUrl,
        origin: q.origin,
        asked_at: q.askedAt,
        expires_at: q.expiresAt,
        // what the user approved in advance, to check a purchase question against (null: nothing)
        ...(q.reason === 'confirm' ? { purchase_approval: run.input.purchaseApproval ?? null } : {}),
      },
      reply_with: { tool: 'agent_reply', arguments: replyArguments(run, q, '<your answer>') },
    },
    isError: false,
  };
}

/** What became of a saved sign-in, for the host. */
function snapshotSavedText(s: SnapshotSaved): string {
  if (s.action === 'refreshed') return `Saved sign-in "${s.name}" was refreshed from the agent's browser (v${s.version}).`;
  if (s.action === 'created') return `The agent saved its sign-in as snapshot "${s.name}" (v${s.version}): pass {"snapshot": "${s.name}"} to agent_run to start a later job signed in.`;
  return `Saved sign-in "${s.name}" was not refreshed: ${s.reason ?? 'unknown reason'}.`;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function describeParam(p: ScriptParam): string {
  const bits = [p.type, p.required ? 'required' : 'optional'];
  if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
  let line = `- ${p.name} (${bits.join(', ')}): ${p.description || '(no description)'}`;
  if (p.example !== undefined) line += ` Example: ${JSON.stringify(p.example)}`;
  return line;
}

/** Usage text for a stored script (agent_automate result, script_get). */
export function scriptUsage(script: ScriptMeta): { text: string; exampleArgs: Record<string, unknown> } {
  const example = exampleParams(script.params) ?? Object.fromEntries(script.params.map((p) => [p.name, p.example ?? p.default ?? `<${p.type}>`]));
  const exampleArgs = { name: script.name, params: example };
  const v = script.verification;
  const verification =
    v.status === 'passed'
      ? `PASSED — version ${v.version} ran successfully in a fresh browser in ${((v.durationMs ?? 0) / 1000).toFixed(1)} s with ${JSON.stringify(v.params ?? {})}`
      : v.status === 'failed'
        ? `FAILED — version ${v.version} with ${JSON.stringify(v.params ?? {})}: ${v.error ?? 'unknown error'}`
        : 'not run';
  const lines = [
    `Script "${script.name}" (version ${script.version}): ${script.description}`,
    `Verification: ${verification}`,
    '',
    `Run it (no model needed): script_run ${JSON.stringify(exampleArgs)}`,
    '',
    'Parameters:',
    ...(script.params.length ? script.params.map(describeParam) : ['- none']),
    '',
    `Returns: ${script.output.description}`,
  ];
  if (v.status === 'passed' && v.output !== undefined) {
    const out = JSON.stringify(v.output, null, 2) ?? 'null';
    lines.push(`Example output (from verification): ${out.length > 1_500 ? `${out.slice(0, 1_500)}\n...` : out}`);
  }
  return { text: lines.join('\n'), exampleArgs };
}

function scriptStructured(script: ScriptMeta, verifiedByAgent: boolean | null, usageNotes: string | null): Record<string, unknown> {
  return {
    name: script.name,
    version: script.version,
    description: script.description,
    params: script.params,
    output: script.output,
    verification: script.verification,
    verified_by_agent: verifiedByAgent,
    usage_notes: usageNotes,
    run_with: { tool: 'script_run', arguments: scriptUsage(script).exampleArgs },
  };
}

export function stillRunningText(run: AgentRun): string {
  const where = run.status === 'queued' ? `waiting for a free slot (${run.activity})` : `step ${run.stepsUsed} of ${run.input.maxSteps}, ${seconds(run.durationMs)} so far; now: ${run.activity}`;
  return (
    `Agent run ${run.id} (${KIND_NAME[run.kind]}) is still running: ${where}. It keeps working in the background.\n` +
    `Call agent_wait with {"run_id": "${run.id}"} to wait for the result (agent_status to check progress, agent_cancel to stop it).`
  );
}

export function runResult(run: AgentRun): { text: string; structured: Record<string, unknown>; isError: boolean } {
  const base = {
    run_id: run.id,
    kind: run.kind,
    status: run.status,
    steps: run.stepsUsed,
    duration_ms: run.durationMs,
    model: run.model,
    forced: run.outcome?.forced ?? false,
  };
  // a pending question comes first: the host has to answer it before anything else happens
  if (run.isWaiting && run.question) return waitingResult(run, run.question, base);
  if (!run.done) {
    return { text: stillRunningText(run), structured: { ...base, activity: run.activity }, isError: false };
  }
  const header = `Agent run ${run.id} (${KIND_NAME[run.kind]}) ${run.status}${run.outcome ? ` — ${run.outcome.success ? 'success' : 'not successful'}` : ''}. ${run.stepsUsed} steps, ${seconds(run.durationMs)}.`;
  // a secret answer from the host (a one-time code) is masked in whatever the agent reported
  const outcome = run.scrubbed(run.outcome);
  const error = run.error && run.scrub(run.error);
  const notes = run.scrubbed(run.notes);
  const lines: string[] = [header];
  const structured: Record<string, unknown> = { ...base, success: outcome?.success ?? false };

  if (!outcome) {
    lines.push(`${run.status === 'cancelled' ? 'Cancelled' : 'Error'}: ${error ?? 'no result'}`);
    if (notes.length) lines.push('', 'Notes the agent saved before it stopped:', ...notes.map((n) => `- ${n}`));
    structured.error = error;
    structured.notes = notes;
    if (run.kind === 'finder' && run.sources.length) {
      // no final answer, but the sources it had already checked are still useful
      lines.push('', 'Sources the agent cited before it stopped:');
      for (const s of run.sources) lines.push(`[${s.n}] ${s.title} — ${s.url}${s.quotes.some((q) => q.verified) ? '' : ' (no verified quote)'}`);
      structured.sources = run.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, quotes: s.quotes }));
    }
    if (run.kind === 'automation' && run.scriptName) {
      // the run did not finish, but the script it saved (and possibly verified) is usable
      const script = run.extra.script as ScriptMeta | undefined;
      if (script) {
        lines.push('', 'The run did not finish, but it saved this script:', '', scriptUsage(script).text);
        structured.script = scriptStructured(script, null, null);
      } else {
        lines.push('', `A script was saved as "${run.scriptName}" (version ${run.scriptVersion}); see script_get.`);
        structured.script = { name: run.scriptName, version: run.scriptVersion };
      }
    }
  } else if (run.kind === 'finder') {
    lines.push('', 'ANSWER:', outcome.answer ?? '', '', `Confidence: ${outcome.confidence}${outcome.insufficientSources ? ' (fewer independent sources than requested)' : ''}`);
    lines.push('', 'SOURCES:');
    if (!run.sources.length) lines.push('- none cited');
    for (const s of run.sources) {
      lines.push(`[${s.n}] ${s.title} — ${s.url}`);
      for (const q of s.quotes.slice(0, 3)) lines.push(`    "${q.text.length > 300 ? `${q.text.slice(0, 297)}...` : q.text}"${q.verified ? '' : ' (quote not verified on the page)'}`);
    }
    if (outcome.conflicts) lines.push('', `Conflicts: ${outcome.conflicts}`);
    if (outcome.notes) lines.push('', `Notes: ${outcome.notes}`);
    Object.assign(structured, {
      answer: run.input.outputFormat === 'json' ? parseJson(outcome.answer) : outcome.answer,
      confidence: outcome.confidence,
      sources: run.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, quotes: s.quotes })),
      conflicts: outcome.conflicts ?? null,
      notes: outcome.notes ?? null,
    });
  } else if (run.kind === 'automation') {
    const script = run.extra.script as ScriptMeta | undefined;
    if (script) {
      const usage = scriptUsage(script);
      lines.push('', usage.text);
      if (outcome.verifiedByAgent === false) lines.push('', 'Warning: the agent reported that the script output is NOT correct or complete (verified=false).');
      if (outcome.usageNotes) lines.push('', `Usage notes: ${outcome.usageNotes}`);
      structured.script = scriptStructured(script, outcome.verifiedByAgent ?? null, outcome.usageNotes ?? null);
    } else {
      lines.push('', 'No script was saved.');
      structured.script = null;
    }
    lines.push('', 'TASK OUTPUT (from the exploratory run):', outcome.output ?? '');
    if (outcome.notes) lines.push('', `Notes: ${outcome.notes}`);
    structured.output = run.input.outputFormat === 'json' ? parseJson(outcome.output) : outcome.output;
    structured.notes = outcome.notes ?? null;
  } else {
    lines.push('', 'OUTPUT:', outcome.output ?? '');
    if (outcome.notes) lines.push('', `Notes: ${outcome.notes}`);
    structured.output = run.input.outputFormat === 'json' ? parseJson(outcome.output) : outcome.output;
    structured.notes = outcome.notes ?? null;
  }
  if (outcome?.forced) lines.push('', 'Note: the agent ran out of steps or time and reported what it had.');
  if (run.questions.length) {
    const answerOf = (q: AgentQuestion) => (q.status !== 'answered' ? null : q.secret ? '[REDACTED]' : q.answer);
    lines.push('', `Questions the agent asked you (paused ${seconds(run.pausedMs)} in total):`);
    for (const q of run.questions) {
      const answer = answerOf(q);
      lines.push(`- ${q.id} (${q.reason}, ${q.status}): ${clip(q.text, 200)}${answer !== null ? ` → ${q.secret ? answer : JSON.stringify(clip(answer, 200))}` : ''}`);
    }
    structured.questions = run.questions.map((q) => ({
      id: q.id,
      text: q.text,
      reason: q.reason,
      origin: q.origin,
      answer: answerOf(q),
      asked_at: q.askedAt,
      answered_at: q.answeredAt,
      status: q.status,
    }));
    structured.waited_ms = run.pausedMs;
  }
  if (run.snapshot) structured.snapshot = { name: run.snapshot.name, version: run.snapshot.version };
  if (run.snapshotSaved) {
    lines.push('', snapshotSavedText(run.snapshotSaved));
    structured.snapshot_saved = { ...run.snapshotSaved };
  }
  if (run.transcriptFile) structured.transcript = run.transcriptFile;
  return { text: lines.join('\n'), structured, isError: !outcome };
}
