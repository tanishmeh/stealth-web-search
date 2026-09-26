import type { ScriptMeta, ScriptParam } from '../scripts/store.ts';
import { exampleParams } from '../scripts/store.ts';
import type { AgentRun } from './run.ts';

/** How agent runs are reported to the host agent: readable text plus structured content. */

export function seconds(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 100) / 10)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

const KIND_NAME = { task: 'agentic', automation: 'automation', finder: 'finder' } as const;

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
  const where = run.status === 'queued' ? `waiting for a free slot (${run.activity})` : `step ${run.step} of ${run.input.maxSteps}, ${seconds(run.durationMs)} so far; now: ${run.activity}`;
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
    steps: run.step,
    duration_ms: run.durationMs,
    model: run.model,
    forced: run.outcome?.forced ?? false,
  };
  if (!run.done) {
    return { text: stillRunningText(run), structured: { ...base, activity: run.activity }, isError: false };
  }
  const header = `Agent run ${run.id} (${KIND_NAME[run.kind]}) ${run.status}${run.outcome ? ` — ${run.outcome.success ? 'success' : 'not successful'}` : ''}. ${run.step} steps, ${seconds(run.durationMs)}.`;
  const outcome = run.outcome;
  const lines: string[] = [header];
  const structured: Record<string, unknown> = { ...base, success: outcome?.success ?? false };

  if (!outcome) {
    lines.push(`${run.status === 'cancelled' ? 'Cancelled' : 'Error'}: ${run.error ?? 'no result'}`);
    if (run.notes.length) lines.push('', 'Notes the agent saved before it stopped:', ...run.notes.map((n) => `- ${n}`));
    structured.error = run.error;
    structured.notes = run.notes;
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
  if (run.transcriptFile) structured.transcript = run.transcriptFile;
  return { text: lines.join('\n'), structured, isError: !outcome };
}
