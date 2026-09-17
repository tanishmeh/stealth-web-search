import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { Browser } from '../browser/browser.ts';
import type { Tab } from '../browser/tab.ts';
import type { Config } from '../config.ts';
import type { Hub, PointerData } from '../dashboard/hub.ts';
import type { Logger } from '../logger.ts';

export type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Tool groups can be enabled selectively with TOOLSETS (e.g. `core,content`),
 * which helps small local models that struggle with large tool lists.
 */
export const TOOL_GROUPS = ['core', 'content', 'forms', 'tabs', 'state', 'debug', 'capture'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

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
   * arguments stay redacted in logs and on the dashboard (LOG_REDACT_SECRETS=true).
   */
  markSensitive(): void;
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
