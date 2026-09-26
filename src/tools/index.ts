import { type Config, ConfigError } from '../config.ts';
import agents from './agents.ts';
import capture from './capture.ts';
import content from './content.ts';
import debug from './debug.ts';
import forms from './forms.ts';
import interaction from './interaction.ts';
import navigation from './navigation.ts';
import scripts from './scripts.ts';
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
  ...agents,
  ...scripts,
];

/**
 * Tools exposed to MCP clients, filtered by TOOLSETS. Accepts group names
 * (core, content, forms, tabs, state, debug, capture, agents, scripts), "all",
 * and individual tool names (e.g. "core,browser_evaluate"). The agent tools
 * are only offered when a model is configured (config/models.json or AGENT_LLM_URL).
 */
export function enabledTools(config: Config): ToolDefinition<any>[] {
  const available = config.agent.enabled ? ALL_TOOLS : ALL_TOOLS.filter((t) => t.group !== 'agents');
  const wanted = new Set(config.browser.toolsets);
  if (wanted.has('all')) return available;
  const unknown = [...wanted].filter(
    (w) => !(TOOL_GROUPS as readonly string[]).includes(w) && !ALL_TOOLS.some((t) => t.name === w),
  );
  if (unknown.length) {
    throw new ConfigError(
      `Invalid configuration:\n  - TOOLSETS: unknown groups or tools: ${unknown.join(', ')} (groups: ${TOOL_GROUPS.join(', ')}, or "all")`,
    );
  }
  return available.filter((t) => wanted.has(t.group) || wanted.has(t.name));
}
