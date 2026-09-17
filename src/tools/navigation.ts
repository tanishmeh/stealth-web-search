import * as z from 'zod';
import { NavigationError, ToolError } from '../browser/errors.ts';
import type { Tab } from '../browser/tab.ts';
import type { Config } from '../config.ts';
import { formatStatus } from './format.ts';
import { ACTION, defineTool, textResult } from './types.ts';

/**
 * Accept what an LLM is likely to type ("example.com", "https://…") and
 * refuse schemes that could read local files or run script URLs.
 */
export function normalizeUrl(input: string, config: Config): string {
  let raw = input.trim();
  if (!raw) throw new ToolError('URL must not be empty');
  if (/^about:blank$/i.test(raw)) return 'about:blank';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(raw);
  // "localhost:3000/path" is host:port, not a URL scheme called "localhost"
  const hasScheme = Boolean(schemeMatch) && !/^\d+(?:[/?#]|$)/.test(schemeMatch![2] ?? '');
  if (!hasScheme) {
    // bare host or host/path: assume https (http for localhost-style hosts)
    const host = raw.split(/[/?#]/)[0] ?? '';
    const local = /^(localhost|127\.|10\.|192\.168\.|host\.docker\.internal)/i.test(host) || /:\d+$/.test(host);
    raw = `${local ? 'http' : 'https'}://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`Invalid URL: ${input}`);
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!config.browser.allowedUrlSchemes.includes(scheme)) {
    throw new ToolError(
      `URL scheme "${scheme}:" is not allowed. Allowed schemes: ${config.browser.allowedUrlSchemes.map((s) => `${s}:`).join(', ')}`,
    );
  }
  return url.href;
}

function describePage(url: string, title: string): string {
  return `${url} — ${JSON.stringify(title)}`;
}

export const navigate = defineTool({
  name: 'browser_navigate',
  title: 'Navigate to URL',
  group: 'core',
  description:
    'Open a URL in the current tab and wait for the page (including its JavaScript) to load. ' +
    'Returns the final URL, page title and HTTP status. Call browser_snapshot next to read the page and get element refs.',
  inputSchema: z.object({
    url: z.string().describe('The URL to open, e.g. "https://example.com". A missing scheme defaults to https://'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle0'])
      .optional()
      .describe('When navigation is considered done (default "load"; use "networkidle0" for pages that load data after load)'),
  }),
  annotations: { ...ACTION, title: 'Navigate to URL' },
  handler: async ({ url, waitUntil }, ctx) => {
    const target = normalizeUrl(url, ctx.config);
    const tab = await ctx.tab();
    const res = await tab.navigate(target, waitUntil ?? 'load');
    let text = `Navigated to ${describePage(res.url, res.title)}${formatStatus(res.status)}`;
    if (res.status !== null && res.status >= 400) text += `\nWarning: the server responded with HTTP ${res.status}.`;
    return textResult(text);
  },
});

async function historyStep(tab: Tab, delta: -1 | 1): Promise<string | null> {
  const history = await tab.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>('Page.getNavigationHistory');
  const target = history.entries[history.currentIndex + delta];
  if (!target) return null;
  const before = tab.navSeq;
  try {
    await tab.send('Page.navigateToHistoryEntry', { entryId: target.id }, 45_000);
  } catch (err) {
    throw new NavigationError(target.url, (err as Error).message);
  }
  if (tab.navSeq === before) await tab.waitForEvent((ev) => ev.method === 'Page.frameStoppedLoading', 500);
  const info = await tab.pageInfo();
  return describePage(info.url, info.title);
}

export const back = defineTool({
  name: 'browser_back',
  title: 'Go back',
  group: 'core',
  description: 'Go back to the previous page in this tab\'s history (like the browser back button).',
  inputSchema: z.object({}),
  annotations: { ...ACTION, title: 'Go back' },
  handler: async (_args, ctx) => {
    const tab = await ctx.tab();
    const page = await historyStep(tab, -1);
    return textResult(page ? `Back to ${page}` : 'No previous page in history.');
  },
});

export const forward = defineTool({
  name: 'browser_forward',
  title: 'Go forward',
  group: 'core',
  description: 'Go forward to the next page in this tab\'s history.',
  inputSchema: z.object({}),
  annotations: { ...ACTION, title: 'Go forward' },
  handler: async (_args, ctx) => {
    const tab = await ctx.tab();
    const page = await historyStep(tab, 1);
    return textResult(page ? `Forward to ${page}` : 'No forward page in history.');
  },
});

export const reload = defineTool({
  name: 'browser_reload',
  title: 'Reload page',
  group: 'core',
  description: 'Reload the current page.',
  inputSchema: z.object({}),
  annotations: { ...ACTION, title: 'Reload page' },
  handler: async (_args, ctx) => {
    const tab = await ctx.tab();
    const current = await tab.pageInfo();
    if (current.url === 'about:blank') return textResult('Nothing to reload (the tab is blank). Use browser_navigate first.');
    const res = await tab.navigate(current.url, 'load');
    return textResult(`Reloaded ${describePage(res.url, res.title)}${formatStatus(res.status)}`);
  },
});

export default [navigate, back, forward, reload];
