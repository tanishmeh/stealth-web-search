import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import type { Tab } from '../browser/tab.ts';
import { ACTION, defineTool, textResult, type ToolDefinition } from '../tools/types.ts';

/**
 * Web search for sub-agents, run in the agent's own browser like a person would: open the
 * search engine's results page and read the organic results. DuckDuckGo's HTML endpoint is
 * fast and reliable from the stealth browser; Bing is the fallback. (Google and Mojeek answer
 * a headless browser with a captcha.)
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchEngine = 'duckduckgo' | 'bing';

const ENGINES: Record<SearchEngine, (q: string) => string> = {
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`,
};

/** Runs in the page: raw results of a DuckDuckGo HTML or Bing results page. */
const READ_RESULTS = `function readResults(engine) {
  function text(el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var out = [];
  var blocked = /captcha|unusual traffic|bots use duckduckgo|anomaly/i.test(document.title + ' ' + (document.body ? document.body.innerText.slice(0, 2000) : ''));
  if (engine === 'duckduckgo') {
    var nodes = document.querySelectorAll('.result');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i];
      if (/result--ad/.test(r.className)) continue;
      var a = r.querySelector('a.result__a');
      if (!a) continue;
      out.push({ title: text(a), href: a.getAttribute('href') || '', snippet: text(r.querySelector('.result__snippet')) });
    }
  } else {
    var items = document.querySelectorAll('li.b_algo');
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var link = it.querySelector('h2 a');
      if (!link) continue;
      var snip = it.querySelector('.b_caption p') || it.querySelector('.b_lineclamp2') || it.querySelector('.b_lineclamp3') || it.querySelector('.b_caption');
      out.push({ title: text(link), href: link.href || link.getAttribute('href') || '', snippet: text(snip) });
    }
  }
  return { results: out, blocked: blocked && out.length === 0, title: document.title };
}`;

/** Resolve a search engine's redirect link to the destination URL. */
export function decodeResultUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com/');
  } catch {
    return null;
  }
  // DuckDuckGo: https://duckduckgo.com/l/?uddg=<encoded url>
  if (/duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
    const target = url.searchParams.get('uddg');
    return target ? safeHttpUrl(target) : null;
  }
  // Bing: https://www.bing.com/ck/a?...&u=a1<base64url of the url>
  if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith('/ck/')) {
    const u = url.searchParams.get('u');
    if (!u || !u.startsWith('a1')) return null;
    try {
      return safeHttpUrl(Buffer.from(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  if (/(^|\.)(duckduckgo|bing)\.com$/i.test(url.hostname)) return null; // engine-internal link
  return safeHttpUrl(url.href);
}

function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function searchWeb(tab: Tab, query: string, engines: SearchEngine[], max: number): Promise<{ engine: SearchEngine; results: SearchResult[] }> {
  const problems: string[] = [];
  for (const engine of engines) {
    try {
      await tab.navigate(ENGINES[engine](query), 'load');
      const raw = await tab.callFunction<{ results: Array<{ title: string; href: string; snippet: string }>; blocked: boolean; title: string }>(
        READ_RESULTS,
        [engine],
      );
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const r of raw?.results ?? []) {
        const url = decodeResultUrl(r.href);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({ title: r.title || url, url, snippet: r.snippet });
        if (results.length >= max) break;
      }
      if (results.length) return { engine, results };
      problems.push(raw?.blocked ? `${engine}: the search engine asked for a captcha` : `${engine}: no results`);
    } catch (err) {
      problems.push(`${engine}: ${(err as Error).message}`);
    }
  }
  if (problems.every((p) => /no results/.test(p))) return { engine: engines[0], results: [] };
  throw new ToolError(`Web search failed (${problems.join('; ')})`);
}

export function formatResults(query: string, engine: SearchEngine, results: SearchResult[]): string {
  if (!results.length) return `No results for ${JSON.stringify(query)}. Try different or fewer words.`;
  const lines = [`Results for ${JSON.stringify(query)} (${engine}):`];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}\n    ${r.url}${r.snippet ? `\n    ${r.snippet}` : ''}`);
  });
  lines.push('Open a result with browser_navigate to read it; snippets alone are not reliable evidence.');
  return lines.join('\n');
}

/** The web_search tool offered to sub-agents. It navigates the agent's active tab. */
export function webSearchTool(primary: SearchEngine, onResults?: (results: SearchResult[]) => void): ToolDefinition<any> {
  const order: SearchEngine[] = primary === 'bing' ? ['bing', 'duckduckgo'] : ['duckduckgo', 'bing'];
  return defineTool({
    name: 'web_search',
    title: 'Search the web',
    group: 'agents',
    description:
      'Search the web and get a numbered list of results (title, URL, snippet). This opens the search results page in your current tab. ' +
      'Then open the most promising results with browser_navigate and read them (browser_markdown); snippets are not evidence.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search query, e.g. "Obscura headless browser license"'),
      max_results: z.number().int().min(1).max(20).optional().describe('Maximum results (default 8)'),
    }),
    annotations: { ...ACTION, title: 'Search the web' },
    handler: async ({ query, max_results }, ctx) => {
      const tab = await ctx.tab();
      const { engine, results } = await searchWeb(tab, query, order, max_results ?? 8);
      onResults?.(results);
      return textResult(formatResults(query, engine, results));
    },
  });
}
