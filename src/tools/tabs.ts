import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import type { NavigationResult, Tab } from '../browser/tab.ts';
import { formatStatus } from './format.ts';
import { normalizeUrl } from './navigation.ts';
import { ACTION, DESTRUCTIVE_LOCAL, LOCAL_STATE, READ_ONLY, defineTool, textResult } from './types.ts';

/** Accept "tab-2", "Tab-2", "2", "tab-02" or " tab-2 ". */
export function normalizeTabId(input: string): string {
  const raw = input.trim();
  const m = /^(?:tab[-_ ]?)?(\d+)$/i.exec(raw);
  return m ? `tab-${Number(m[1])}` : raw;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

/** Refresh URL/title of the active tab only: talking to background tabs can reset their JS state in Obscura v0.2.2. */
async function refreshActive(tab: Tab | null): Promise<void> {
  if (!tab || tab.closed) return;
  try {
    await tab.pageInfo();
  } catch {
    // keep the last known URL/title
  }
}

export const tabNew = defineTool({
  name: 'browser_tab_new',
  title: 'Open new tab',
  group: 'tabs',
  description:
    'Open a new browser tab, optionally loading a URL, and make it the active tab (all other browser tools then act on it). ' +
    'All tabs share cookies. Obscura v0.2.2 limitation: a background tab may lose its in-page JavaScript state (variables, event listeners) ' +
    'when you work in another tab, so prefer one tab at a time and reload a page that stops reacting.',
  inputSchema: z.object({
    url: z.string().optional().describe('URL to open in the new tab (default: a blank tab)'),
  }),
  annotations: { ...ACTION, title: 'Open new tab' },
  handler: async ({ url }, ctx) => {
    const target = url !== undefined && url.trim() !== '' ? normalizeUrl(url, ctx.config) : null;
    const tab = await ctx.browser.newTab();
    if (!target || target === 'about:blank') return textResult(`Opened ${tab.id} (about:blank); it is now the active tab.`);
    let res: NavigationResult;
    try {
      res = await tab.navigate(target, 'load');
    } catch (err) {
      if (err instanceof ToolError) throw new ToolError(`Opened ${tab.id} (now the active tab), but ${err.message}`);
      throw err;
    }
    let text = `Opened ${tab.id} and navigated to ${res.url} — ${JSON.stringify(res.title)}${formatStatus(res.status)}`;
    if (res.status !== null && res.status >= 400) text += `\nWarning: the server responded with HTTP ${res.status}.`;
    return textResult(text);
  },
});

export const tabList = defineTool({
  name: 'browser_tab_list',
  title: 'List tabs',
  group: 'tabs',
  description: 'List open tabs with their id, URL and title. The active tab (the one other tools act on) is marked with *.',
  inputSchema: z.object({}),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'List tabs' },
  handler: async (_args, ctx) => {
    await refreshActive(ctx.browser.activeTab);
    const tabs = ctx.browser.listTabs();
    if (tabs.length === 0) return textResult('No tabs open.');
    return textResult(tabs.map((t) => `${t.active ? '*' : ' '} ${t.id}  ${t.url}  ${JSON.stringify(oneLine(t.title))}`).join('\n'));
  },
});

export const tabSwitch = defineTool({
  name: 'browser_tab_switch',
  title: 'Switch tab',
  group: 'tabs',
  description:
    'Make another open tab the active tab; all following browser tools act on it. Use browser_tab_list to see tab ids. ' +
    'Element refs from other tabs do not apply; call browser_snapshot after switching.',
  inputSchema: z.object({
    tab_id: z.string().describe('Tab id from browser_tab_list, e.g. "tab-2"'),
  }),
  annotations: { ...LOCAL_STATE, title: 'Switch tab' },
  handler: async ({ tab_id }, ctx) => {
    const tab = ctx.browser.switchTab(normalizeTabId(tab_id));
    await refreshActive(tab);
    return textResult(`Active tab: ${tab.id} — ${tab.url} ${JSON.stringify(oneLine(tab.title))}`);
  },
});

export const tabClose = defineTool({
  name: 'browser_tab_close',
  title: 'Close tab',
  group: 'tabs',
  description:
    'Close a tab (default: the active tab). If the active tab is closed, the most recently opened remaining tab becomes active.',
  inputSchema: z.object({
    tab_id: z.string().optional().describe('Tab id to close, e.g. "tab-2" (default: the active tab)'),
  }),
  annotations: { ...DESTRUCTIVE_LOCAL, title: 'Close tab' },
  handler: async ({ tab_id }, ctx) => {
    const id = tab_id !== undefined && tab_id.trim() !== '' ? normalizeTabId(tab_id) : ctx.browser.activeTab?.id;
    if (!id) throw new ToolError('No tab to close: no tabs are open.');
    const { closed, active } = await ctx.browser.closeTab(id);
    return textResult(active ? `Closed ${closed}. Active tab is now ${active}.` : `Closed ${closed}. No tabs remain.`);
  },
});

export const close = defineTool({
  name: 'browser_close',
  title: 'Close all tabs',
  group: 'tabs',
  description:
    'Close every tab and discard their pages, console and network logs. Cookies are kept (use browser_clear_cookies to remove them). ' +
    'A fresh blank tab opens automatically on the next browser tool call.',
  inputSchema: z.object({}),
  annotations: { ...DESTRUCTIVE_LOCAL, title: 'Close all tabs' },
  handler: async (_args, ctx) => {
    const count = ctx.browser.tabCount === 0 ? 0 : await ctx.browser.closeAll();
    if (count === 0) return textResult('No tabs were open. A fresh tab opens automatically on the next browser tool call.');
    return textResult(`Closed ${count} tab(s). A fresh tab opens automatically on the next browser tool call.`);
  },
});

export default [tabNew, tabList, tabSwitch, tabClose, close];
