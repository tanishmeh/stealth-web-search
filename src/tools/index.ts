import type { Config } from '../config.ts';
import capture from './capture.ts';
import content from './content.ts';
import debug from './debug.ts';
import forms from './forms.ts';
import interaction from './interaction.ts';
import navigation from './navigation.ts';
import snapshot from './snapshot.ts';
import state from './state.ts';
import tabs from './tabs.ts';
import { TOOL_GROUPS, type ToolDefinition } from './types.ts';
import waits from './waits.ts';

export const ALL_TOOLS: ToolDefinition<any>[] = [
  ...navigation,
  ...snapshot,
  ...interaction,
  ...waits,
  ...capture,
  ...content,
  ...forms,
  ...tabs,
  ...state,
  ...debug,
];

/**
 * Tools exposed to MCP clients, filtered by TOOLSETS. Accepts group names
 * (core, content, forms, tabs, state, debug, capture), "all", and individual
 * tool names (e.g. "core,browser_evaluate").
 */
export function enabledTools(config: Config): ToolDefinition<any>[] {
  const wanted = new Set(config.browser.toolsets);
  if (wanted.has('all')) return ALL_TOOLS;
  const unknown = [...wanted].filter(
    (w) => !(TOOL_GROUPS as readonly string[]).includes(w) && !ALL_TOOLS.some((t) => t.name === w),
  );
  if (unknown.length) throw new Error(`TOOLSETS contains unknown groups or tools: ${unknown.join(', ')}`);
  return ALL_TOOLS.filter((t) => wanted.has(t.group) || wanted.has(t.name));
}
