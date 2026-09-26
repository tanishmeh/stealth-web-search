import * as z from 'zod';
import { scriptUsage } from '../agents/format.ts';
import { ToolError } from '../browser/errors.ts';
import type { ScriptService } from '../scripts/service.ts';
import { redactParams } from '../mcp/server.ts';
import { ScriptError } from '../scripts/store.ts';
import { defineTool, textResult, type ToolContext } from './types.ts';
import type { ToolAnnotations } from '@modelcontextprotocol/server';

/**
 * Stored automation scripts (written by agent_automate): list, inspect, run and delete them.
 * Running needs no model: the script replays the browser steps in a fresh isolated browser.
 */

const INSPECT: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function service(ctx: ToolContext): ScriptService {
  if (!ctx.scripts) throw new ToolError('The script store is not available on this server.');
  return ctx.scripts;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ScriptError) throw new ToolError(err.message);
    throw err;
  }
}

export const scriptList = defineTool({
  name: 'script_list',
  title: 'List automation scripts',
  group: 'scripts',
  description: 'List the stored automation scripts (made by agent_automate) with their parameters and verification status.',
  inputSchema: z.object({}),
  annotations: INSPECT,
  concurrent: true,
  handler: async (_args, ctx) => {
    const scripts = await service(ctx).store.list();
    const invalid = await service(ctx).store.invalidNames();
    const invalidNote = invalid.length ? `\nIgnored ${invalid.length} script(s) with invalid metadata: ${invalid.join(', ')} (fix their .json file or remove them with script_delete).` : '';
    if (!scripts.length) return textResult(`No scripts stored yet. Create one with agent_automate.${invalidNote}`);
    const lines = scripts.map((s) => {
      const params = s.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ');
      return `- ${s.name} (v${s.version}, verification ${s.verification.status}, ${s.runs} run${s.runs === 1 ? '' : 's'}): ${s.description}\n    params: ${params || 'none'}`;
    });
    return {
      content: [{ type: 'text', text: `${scripts.length} script(s):\n${lines.join('\n')}\nUse script_get for details and script_run to run one.${invalidNote}` }],
      structuredContent: { scripts: scripts.map((s) => ({ name: s.name, version: s.version, description: s.description, params: s.params, verification: s.verification.status, runs: s.runs })) },
    };
  },
});

export const scriptGet = defineTool({
  name: 'script_get',
  title: 'Show an automation script',
  group: 'scripts',
  description: 'Show a stored script: what it does, its parameters, how to run it, verification status and (optionally) its source code.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Script name, from script_list'),
    include_code: z.boolean().optional().describe('Include the JavaScript source (default true)'),
  }),
  annotations: INSPECT,
  concurrent: true,
  handler: async ({ name, include_code }, ctx) =>
    guard(async () => {
      const script = await service(ctx).store.get(name.trim());
      const usage = scriptUsage(script);
      let text = usage.text;
      if (script.task) text += `\n\nRecorded for the task: ${script.task}`;
      text += `\n\nRuns: ${script.runs}${script.lastRunAt ? ` (last ${script.lastRunAt}, ${script.lastRunStatus})` : ''}`;
      if (include_code !== false) text += `\n\nSource (${script.name}.js):\n${script.code}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...script, code: include_code === false ? undefined : script.code, run_with: { tool: 'script_run', arguments: usage.exampleArgs } },
      };
    }),
});

export const scriptRun = defineTool({
  name: 'script_run',
  title: 'Run an automation script',
  group: 'scripts',
  description:
    'Run a stored automation script with parameters, without any model: it replays the recorded browser job in a fresh isolated browser ' +
    'and returns the script output (JSON) and its log. Parameters are validated and defaulted from the script definition (see script_get).',
  inputSchema: z.object({
    name: z.string().min(1).describe('Script name, from script_list'),
    params: z.record(z.string(), z.any()).optional().describe('Parameter values, e.g. {"query": "rust", "limit": 5}'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  concurrent: true,
  handler: async ({ name, params }, ctx) =>
    guard(async () => {
      const svc = service(ctx);
      let calls = 0;
      const res = await svc.run(name.trim(), params ?? {}, {
        client: ctx.session.client ? `${ctx.session.client} › script:${name}` : `script:${name}`,
        signal: ctx.signal,
        onProgress: (message) => {
          calls++;
          void ctx.progress?.({ progress: calls, message });
        },
      });
      const out = JSON.stringify(res.output, null, 2) ?? 'null';
      // results are logged: password-like parameters are masked (the caller knows what it sent)
      const shownParams = ctx.config.log.redactSecrets ? redactParams(res.params) : res.params;
      const lines = [
        `Script ${res.script.name} v${res.script.version} ${res.ok ? 'finished' : 'FAILED'} in ${(res.durationMs / 1000).toFixed(1)} s (${res.calls} browser calls) with params ${JSON.stringify(shownParams)}.`,
      ];
      if (res.ok) lines.push(`Output:\n${out.length > 60_000 ? `${out.slice(0, 60_000)}\n...[${out.length - 60_000} more characters]` : out}`);
      else lines.push(`Error: ${res.error}`);
      if (res.logs.length) lines.push(`Log:\n${res.logs.slice(-50).join('\n')}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          script: res.script,
          params: shownParams,
          ok: res.ok,
          output: res.ok ? res.output : null,
          error: res.error ?? null,
          logs: res.logs,
          duration_ms: res.durationMs,
          final_url: res.finalUrl,
        },
        isError: res.ok ? undefined : true,
      };
    }),
});

export const scriptDelete = defineTool({
  name: 'script_delete',
  title: 'Delete an automation script',
  group: 'scripts',
  description: 'Delete a stored automation script (its code and metadata files).',
  inputSchema: z.object({ name: z.string().min(1).describe('Script name, from script_list') }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  concurrent: true,
  handler: async ({ name }, ctx) =>
    guard(async () => {
      await service(ctx).store.delete(name.trim());
      return textResult(`Deleted script ${name.trim()}.`);
    }),
});

export default [scriptList, scriptGet, scriptRun, scriptDelete];
