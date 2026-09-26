import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { AgentManager } from '../agents/manager.ts';
import type { Browser } from '../browser/browser.ts';
import type { Tab } from '../browser/tab.ts';
import type { Config } from '../config.ts';
import type { Hub, PointerData } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';
import type { ScriptService } from '../scripts/service.ts';
import type { SnapshotService } from '../snapshots/service.ts';

export type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Tool groups can be enabled selectively with TOOLSETS (e.g. `core,content`),
 * which helps small local models that struggle with large tool lists.
 */
export const TOOL_GROUPS = ['core', 'content', 'forms', 'tabs', 'state', 'debug', 'capture', 'agents', 'scripts', 'snapshots'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** MCP progress notification for the calling client (long-running agent and script tools). */
export type ProgressFn = (p: { progress: number; total?: number; message?: string }) => Promise<void>;

export interface ToolContext {
  browser: Browser;
  config: Config;
  hub: Hub;
  log: Logger;
  callId: string;
  session: { id: string | null; client: string | null };
  /** The active tab, opened on demand. */
  tab(): Promise<Tab>;
  /** Show an interaction marker (click, typing, …) on the dashboard live view. */
  pointer(tab: Tab, x: number, y: number, kind: PointerData['kind'], label?: string): void;
  /**
   * Tell the logger this call handled a secret (e.g. it typed into a password field), so its
   * arguments stay redacted in logs and on the dashboard (LOG_REDACT_SECRETS=true). `shown.result`
   * replaces the result text in logs and on the dashboard, always (e.g. a secret answer from the host).
   */
  markSensitive(shown?: { result?: string }): void;
  /**
   * A sub-agent call whose typed value contains a secret the host gave it (a one-time code): typing
   * tools treat the field as sensitive and keep the value out of every log, whatever LOG_REDACT_SECRETS says.
   */
  secretInput?: boolean;
  /**
   * Sub-agent task runs: checks the label of a control before a click, Enter or Space activates it, and
   * returns why that is refused (the final step of an order or payment the host has not approved) or null.
   */
  purchaseGuard?: (label: string, pageUrl: string) => string | null;
  /** Sub-agent runs; null when no agent model is configured. */
  agents: AgentManager | null;
  /** Stored automation scripts. */
  scripts: ScriptService | null;
  /** Saved sign-ins (snapshots). */
  snapshots: SnapshotService | null;
  /** Report progress to the calling client, when it asked for progress notifications. */
  progress?: ProgressFn;
  /** Aborted when the calling client cancels the request. */
  signal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  group: ToolGroup;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  /**
   * Secrets handled by this tool, hidden from logs and the dashboard when LOG_REDACT_SECRETS=true:
   * `args` lists argument names whose values are redacted, `result` hides the whole result text.
   */
  sensitive?: { args?: string[]; result?: boolean };
  /**
   * The tool does not use the main browser (sub-agent and script tools): it runs outside the
   * browser queue and TOOL_TIMEOUT_MS, and bounds its own waiting.
   */
  concurrent?: boolean;
  handler: (args: z.output<S>, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const ACTION: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const LOCAL_STATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const DESTRUCTIVE_LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
