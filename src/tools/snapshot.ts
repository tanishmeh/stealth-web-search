import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { COLLECT_INTERACTIVE, EXTRACT_TEXT } from '../browser/scripts.ts';
import { DEFAULT_TEXT_LIMIT, formatInteractive, truncate, type InteractiveItem } from './format.ts';
import { READ_ONLY, defineTool, textResult } from './types.ts';

interface Collected {
  elements: InteractiveItem[];
  total: number;
  hidden: number;
  error?: string;
}

export const snapshot = defineTool({
  name: 'browser_snapshot',
  title: 'Read page',
  group: 'core',
  description:
    'Read the current page: URL, title, scroll position, the readable text, and a list of interactive elements ' +
    '(links, buttons, inputs…) each with a ref like "e3". Pass a ref to browser_click, browser_fill, browser_type, etc. ' +
    'Refs stay valid until the page navigates. Call this after navigating or whenever the page may have changed.',
  inputSchema: z.object({
    max_chars: z.number().int().min(0).max(200_000).optional().describe(`Maximum characters of page text (default ${DEFAULT_TEXT_LIMIT})`),
    include_elements: z.boolean().optional().describe('Include the interactive element list (default true)'),
    max_elements: z.number().int().min(1).max(1000).optional().describe('Maximum interactive elements to list (default 100)'),
  }),
  annotations: { ...READ_ONLY, title: 'Read page' },
  handler: async ({ max_chars, include_elements, max_elements }, ctx) => {
    const tab = await ctx.tab();
    const info = await tab.pageInfo();
    const body = (await tab.callFunction<string | null>(EXTRACT_TEXT, [null])) ?? '';
    const lines = [
      `URL: ${info.url}`,
      `Title: ${info.title}`,
      `Scroll: y=${info.scrollY} of ${info.pageHeight}px page (viewport ${info.innerWidth}x${info.innerHeight})`,
      '',
      truncate(body, max_chars ?? DEFAULT_TEXT_LIMIT) || '(no text content)',
    ];

    if (include_elements ?? true) {
      const limit = max_elements ?? 100;
      const collected = await tab.callFunction<Collected>(COLLECT_INTERACTIVE, [{ limit }]);
      if (collected.error) throw new ToolError(collected.error);
      const visibleTotal = collected.total - collected.hidden;
      lines.push('');
      if (collected.elements.length === 0) {
        lines.push('Interactive elements: none visible.');
      } else {
        const shown = collected.elements.length;
        lines.push(
          `Interactive elements (${shown === visibleTotal ? shown : `showing ${shown} of ${visibleTotal}`} visible; pass ref to browser_click / browser_fill / browser_type):`,
        );
        lines.push(...formatInteractive(tab, collected.elements));
        if (shown < visibleTotal) lines.push(`…${visibleTotal - shown} more. Call browser_interactive_elements with a higher limit to see them.`);
      }
    }
    return textResult(lines.join('\n'));
  },
});

export const interactiveElements = defineTool({
  name: 'browser_interactive_elements',
  title: 'List interactive elements',
  group: 'content',
  description:
    'List clickable and typeable elements on the current page with refs (e.g. "e3") for browser_click / browser_fill / browser_type. ' +
    'Use include_hidden to also list elements that are not currently visible.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(2000).optional().describe('Maximum number of elements (default 100)'),
    include_hidden: z.boolean().optional().describe('Also list hidden / zero-size elements (default false)'),
    selector: z.string().optional().describe('Only list elements inside the first element matching this CSS selector'),
  }),
  annotations: { ...READ_ONLY, title: 'List interactive elements' },
  handler: async ({ limit, include_hidden, selector }, ctx) => {
    const tab = await ctx.tab();
    const collected = await tab.callFunction<Collected>(COLLECT_INTERACTIVE, [
      { limit: limit ?? 100, includeHidden: include_hidden ?? false, rootSelector: selector ?? null },
    ]);
    if (collected.error) throw new ToolError(selector ? `No element matches selector ${JSON.stringify(selector)}` : collected.error);
    if (collected.elements.length === 0) return textResult('No interactive elements on this page.');
    const lines = formatInteractive(tab, collected.elements);
    const available = include_hidden ? collected.total : collected.total - collected.hidden;
    if (collected.elements.length < available) lines.push(`…${available - collected.elements.length} more (raise limit to see them).`);
    return textResult(lines.join('\n'));
  },
});

export default [snapshot, interactiveElements];
