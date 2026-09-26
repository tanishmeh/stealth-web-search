import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { runResult, seconds } from '../agents/format.ts';
import { AgentBusyError, type AgentManager } from '../agents/manager.ts';
import type { AgentInput, AgentKind, AgentRun } from '../agents/run.ts';
import { defineTool, type CallToolResult, type ToolContext } from './types.ts';
import type { ToolAnnotations } from '@modelcontextprotocol/server';

/**
 * Sub-agents for the host agent: hand over a whole browser job (TASK + OUTPUT) to an agent that
 * runs inside this server with its own isolated browser and an OpenAI-compatible model.
 */

const AGENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const INSPECT: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const waitSeconds = z
  .number()
  .min(0)
  .max(3_600)
  .optional()
  .describe('Seconds to wait for the result before returning "still running" (the run continues; collect it with agent_wait). Default: server setting (AGENT_WAIT_SECONDS)');
const maxSteps = z.number().int().min(1).max(200).optional().describe('Step budget (model turns). Default: server setting (AGENT_MAX_STEPS)');
const context = z.string().optional().describe('Extra context: constraints, preferences, what is already known');
const outputFormat = z.enum(['text', 'json']).optional().describe('"json" if the OUTPUT must be valid JSON (it is then validated and parsed)');

function manager(ctx: ToolContext): AgentManager {
  if (!ctx.agents) throw new ToolError('Sub-agents are not configured on this server: set AGENT_LLM_URL (see docs/AGENTS.md).');
  return ctx.agents;
}

function buildInput(ctx: ToolContext, fields: Partial<AgentInput> & { task: string; output: string }): AgentInput {
  return {
    outputFormat: 'text',
    ...fields,
    maxSteps: fields.maxSteps ?? ctx.config.agent.maxSteps,
  };
}

function toResult(run: AgentRun): CallToolResult {
  const r = runResult(run);
  return { content: [{ type: 'text', text: r.text }], structuredContent: r.structured, isError: r.isError || undefined };
}

/** Wait for the run (bounded), relaying progress to the MCP client, then report it. */
async function awaitRun(ctx: ToolContext, run: AgentRun, waitFor: number | undefined): Promise<CallToolResult> {
  const agents = manager(ctx);
  const ms = Math.round((waitFor ?? ctx.config.agent.waitSeconds) * 1000);
  // MCP requires progress to increase with every notification: steps, plus small increments for heartbeats
  let last = -1;
  await agents.wait(
    run,
    ms,
    ctx.progress
      ? (r) => {
          const progress = Math.max(r.step, Math.round((last + 0.01) * 100) / 100);
          last = progress;
          void ctx.progress!({
            progress,
            total: Math.max(r.input.maxSteps, Math.ceil(progress)),
            message: r.status === 'queued' ? r.activity : `step ${r.step}: ${r.activity}`,
          });
        }
      : undefined,
    ctx.signal,
  );
  return toResult(run);
}

function start(ctx: ToolContext, kind: AgentKind, input: AgentInput): AgentRun {
  try {
    return manager(ctx).start(kind, input, ctx.session.client);
  } catch (err) {
    if (err instanceof AgentBusyError) throw new ToolError(err.message);
    throw err;
  }
}

export const agentRun = defineTool({
  name: 'agent_run',
  title: 'Run a browser agent (agentic mode)',
  group: 'agents',
  description:
    'Hand a browser task to a sub-agent. It works in its own isolated browser (own tabs and cookies; your browser is not touched), ' +
    'completes the TASK on its own (navigating, clicking, filling forms, reading pages, searching the web) and returns the OUTPUT you describe. ' +
    'Use it for multi-step jobs you do not need to drive step by step. Runs can take minutes; if the result is not ready in time you get a run_id for agent_wait.',
  inputSchema: z.object({
    task: z.string().min(1).describe('TASK: what the agent must do, with all details it needs (sites, values, criteria)'),
    output: z.string().min(1).describe('OUTPUT: exactly what the agent must send back (content, format, fields), e.g. "a JSON array of {name, price}"'),
    output_format: outputFormat,
    start_url: z.string().optional().describe('Page to begin at, if known'),
    context,
    max_steps: maxSteps,
    wait_seconds: waitSeconds,
  }),
  annotations: { ...AGENT, title: 'Run a browser agent' },
  concurrent: true,
  handler: async (args, ctx) => {
    const run = start(
      ctx,
      'task',
      buildInput(ctx, { task: args.task, output: args.output, outputFormat: args.output_format, startUrl: args.start_url, context: args.context, maxSteps: args.max_steps }),
    );
    return awaitRun(ctx, run, args.wait_seconds);
  },
});

export const agentAutomate = defineTool({
  name: 'agent_automate',
  title: 'Automate a browser task as a reusable script',
  group: 'agents',
  description:
    'Hand a browser task to an automation agent. It does the TASK once in its own isolated browser to learn how, then writes a reusable script that repeats it ' +
    'for new parameter values, verifies the script in a fresh browser, and stores it. Returns the script name, its parameters (types, meaning, examples), ' +
    'how to run it, the verification result, and the OUTPUT of the task itself. Run the script later with script_run — no model needed, much faster.',
  inputSchema: z.object({
    task: z.string().min(1).describe('TASK: the job to automate, with concrete example values (they become the script parameters\' examples)'),
    output: z.string().min(1).describe('OUTPUT: what the task (and the script) must return, e.g. "JSON array of {title, url} for the top N results"'),
    parameters: z
      .string()
      .optional()
      .describe('Which values should be script parameters, e.g. "the search query and the number of results" (default: the agent decides)'),
    script_name: z.string().optional().describe('Name to store the script under (lowercase letters, digits, "-"); default: derived from the task'),
    overwrite: z.boolean().optional().describe('Replace an existing script with the same script_name (default false: a new name is chosen)'),
    output_format: outputFormat,
    start_url: z.string().optional().describe('Page to begin at, if known'),
    context,
    max_steps: maxSteps,
    wait_seconds: waitSeconds,
  }),
  annotations: { ...AGENT, title: 'Automate a browser task' },
  concurrent: true,
  handler: async (args, ctx) => {
    if (!ctx.scripts) throw new ToolError('The script store is not available on this server.');
    let scriptName: string | undefined;
    if (args.script_name) {
      scriptName = args.script_name.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scriptName)) throw new ToolError('script_name must be 1-64 lowercase letters, digits, "-" or "_"');
    }
    const extra = args.parameters ? `Script parameters wanted by the host: ${args.parameters}` : '';
    const run = start(
      ctx,
      'automation',
      buildInput(ctx, {
        task: args.task,
        output: args.output,
        outputFormat: args.output_format,
        startUrl: args.start_url,
        context: [args.context, extra].filter(Boolean).join('\n') || undefined,
        maxSteps: args.max_steps ?? Math.max(ctx.config.agent.maxSteps, 50),
        scriptName,
        overwrite: args.overwrite,
      }),
    );
    return awaitRun(ctx, run, args.wait_seconds);
  },
});

export const agentFind = defineTool({
  name: 'agent_find',
  title: 'Find information on the web (with sources)',
  group: 'agents',
  description:
    'Give a finder agent an OBJECTIVE (a question or a specific thing to find). It searches the web in its own isolated browser, reads the pages, ' +
    'cross-checks the facts on several independent websites, and returns the answer with a confidence level, conflicts between sources, and the links it cited ' +
    '(each with the supporting quote).',
  inputSchema: z.object({
    objective: z.string().min(1).describe('OBJECTIVE: what to find, as specific as possible (e.g. "the current stable version of Node.js and its release date")'),
    output: z.string().optional().describe('OUTPUT: how the answer should be given (default: a concise, complete answer)'),
    min_sources: z.number().int().min(1).max(6).optional().describe('Independent websites the answer must be confirmed on (default 2)'),
    output_format: outputFormat,
    context,
    max_steps: maxSteps,
    wait_seconds: waitSeconds,
  }),
  annotations: { ...AGENT, readOnlyHint: true, title: 'Find information on the web' },
  concurrent: true,
  handler: async (args, ctx) => {
    const run = start(
      ctx,
      'finder',
      buildInput(ctx, {
        task: args.objective,
        output: args.output ?? 'A concise but complete answer to the objective.',
        outputFormat: args.output_format,
        context: args.context,
        maxSteps: args.max_steps,
        minSources: args.min_sources ?? 2,
      }),
    );
    return awaitRun(ctx, run, args.wait_seconds);
  },
});

export const agentWait = defineTool({
  name: 'agent_wait',
  title: 'Wait for an agent run',
  group: 'agents',
  description: 'Wait for a sub-agent run (agent_run, agent_automate, agent_find) to finish and return its result; returns "still running" again if it is not done in time.',
  inputSchema: z.object({
    run_id: z.string().min(1).describe('The run id, e.g. "r1a2b3c4"'),
    wait_seconds: waitSeconds,
  }),
  annotations: INSPECT,
  concurrent: true,
  handler: async ({ run_id, wait_seconds }, ctx) => {
    const run = manager(ctx).get(run_id);
    if (!run) throw new ToolError(`No agent run ${JSON.stringify(run_id)}. Recent runs: ${manager(ctx).list().slice(0, 10).map((r) => r.id).join(', ') || 'none'}`);
    return awaitRun(ctx, run, wait_seconds);
  },
});

export const agentStatus = defineTool({
  name: 'agent_status',
  title: 'Agent run status',
  group: 'agents',
  description: 'Show one sub-agent run (progress, or its result when finished), or list recent runs when run_id is omitted.',
  inputSchema: z.object({ run_id: z.string().optional().describe('The run id; omit to list recent runs') }),
  annotations: INSPECT,
  concurrent: true,
  handler: async ({ run_id }, ctx) => {
    const agents = manager(ctx);
    if (run_id) {
      const run = agents.get(run_id);
      if (!run) throw new ToolError(`No agent run ${JSON.stringify(run_id)}`);
      return toResult(run);
    }
    const runs = agents.list().slice(0, 20);
    if (!runs.length) return { content: [{ type: 'text', text: 'No agent runs yet.' }] };
    const lines = runs.map(
      (r) =>
        `${r.id}  ${r.kind.padEnd(10)} ${r.status.padEnd(9)} ${r.done ? (r.outcome?.success ? 'success' : 'no result') : `step ${r.step}/${r.input.maxSteps}`}  ${seconds(r.durationMs)}  ${r.input.task.replace(/\s+/g, ' ').slice(0, 80)}`,
    );
    return {
      content: [{ type: 'text', text: `Recent agent runs (${agents.activeCount} running, ${agents.queuedCount} queued):\n${lines.join('\n')}` }],
      structuredContent: { runs: runs.map((r) => r.summary()) },
    };
  },
});

export const agentCancel = defineTool({
  name: 'agent_cancel',
  title: 'Cancel an agent run',
  group: 'agents',
  description: 'Stop a running or queued sub-agent run. Its browser is closed; a script it already saved is kept.',
  inputSchema: z.object({ run_id: z.string().min(1).describe('The run id') }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  concurrent: true,
  handler: async ({ run_id }, ctx) => {
    const agents = manager(ctx);
    const run = agents.cancel(run_id);
    if (!run) throw new ToolError(`No agent run ${JSON.stringify(run_id)}`);
    if (run.done && run.status !== 'cancelled') return { content: [{ type: 'text', text: `Run ${run.id} already ${run.status}.` }] };
    await agents.wait(run, 30_000);
    const state =
      run.status === 'cancelled'
        ? 'cancelled'
        : run.done
          ? `finished before it could be cancelled (${run.status}); agent_status has its result`
          : 'is stopping (its current browser action is finishing)';
    return { content: [{ type: 'text', text: `Run ${run.id} ${state}.` }] };
  },
});

export default [agentRun, agentAutomate, agentFind, agentWait, agentStatus, agentCancel];
