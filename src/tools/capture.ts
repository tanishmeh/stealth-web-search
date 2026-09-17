import * as z from 'zod';
import { ToolError } from '../browser/errors.ts';
import { CdpError, CdpTimeoutError } from '../cdp/client.ts';
import { measure, targetShape } from './interaction.ts';
import { LOCAL_STATE, READ_ONLY, defineTool, textResult } from './types.ts';

/** Full scrollable page size in CSS pixels, used to reject captures Obscura cannot render. */
const FULL_PAGE_SIZE = `function fullPageSize() {
  var se = document.scrollingElement || document.documentElement || document.body;
  var b = document.body;
  return {
    width: Math.max(se ? se.scrollWidth : 0, b ? b.scrollWidth : 0, window.innerWidth || 0),
    height: Math.max(se ? se.scrollHeight : 0, b ? b.scrollHeight : 0, window.innerHeight || 0),
  };
}`;

export const screenshot = defineTool({
  name: 'browser_screenshot',
  title: 'Take screenshot',
  group: 'core',
  description:
    'Capture a screenshot of the current viewport (or the full page, or one element) as an image. ' +
    'Use browser_snapshot to read text; use this to check visual layout.',
  inputSchema: z.object({
    full_page: z.boolean().optional().describe('Capture the whole scrollable page instead of just the viewport'),
    ...targetShape,
    format: z.enum(['png', 'jpeg']).optional().describe('Image format (default "png")'),
    quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100 (default 80)'),
  }),
  annotations: { ...READ_ONLY, title: 'Take screenshot' },
  handler: async ({ full_page, ref, selector, format, quality }, ctx) => {
    const tab = await ctx.tab();
    // refuse to capture a page that navigated itself to a blocked scheme (file:, javascript:)
    const info = await tab.pageInfo();
    const fmt = format ?? 'png';
    const params: Record<string, unknown> = { format: fmt };
    if (fmt === 'jpeg') params.quality = quality ?? 80;
    let what = 'viewport';

    if (ref || selector) {
      if (full_page) throw new ToolError('full_page cannot be combined with ref/selector');
      const handle = await tab.resolveElement({ ref, selector });
      const box = await measure(tab, handle);
      if (!box.visible) throw new ToolError(`Element ${handle.target} is not visible, so it cannot be captured`);
      // Page.captureScreenshot clips in document coordinates, so the viewport box (which reflects the
      // scroll that measure() did to bring the element into view) is converted to document coordinates.
      // captureBeyondViewport keeps elements taller than the viewport from being cut off.
      const x = Math.max(0, box.x + box.scrollX - box.width / 2);
      const y = Math.max(0, box.y + box.scrollY - box.height / 2);
      params.clip = { x, y, width: Math.max(1, box.width), height: Math.max(1, box.height), scale: 1 };
      params.captureBeyondViewport = true;
      what = `element ${handle.target}`;
    } else if (full_page) {
      const size = await tab.callFunction<{ width: number; height: number }>(FULL_PAGE_SIZE);
      const pixels = size.width * size.height;
      if (pixels > MAX_CAPTURE_PIXELS) {
        throw new ToolError(
          `The full page is ${size.width}x${size.height} px (${(pixels / 1024 / 1024).toFixed(1)} megapixels), more than Obscura can render in one image (16 megapixels). ` +
            'Capture the current viewport (omit full_page), a specific element (pass ref or selector), or reduce the viewport height with browser_set_viewport.',
        );
      }
      params.captureBeyondViewport = true;
      what = 'full page';
    }

    let shot: { data: string };
    try {
      shot = await tab.send<{ data: string }>('Page.captureScreenshot', params, 60_000);
    } catch (err) {
      if (err instanceof CdpError && /too large|exceeds|megapixel|dimension|out of memory|allocat/i.test(err.message)) {
        throw new ToolError(
          `Could not capture ${what} of ${info.url}: the image is too large for Obscura to render (its limit is 16 megapixels). ` +
            'Capture the viewport or a specific element, or reduce the viewport size with browser_set_viewport.',
        );
      }
      if (err instanceof CdpError) throw new ToolError(`Could not capture ${what} of ${info.url}: ${err.message}`);
      throw err;
    }
    const kb = Math.round((shot.data.length * 3) / 4 / 1024);
    return {
      content: [
        { type: 'text', text: `Screenshot of the ${what} of ${info.url} — ${JSON.stringify(info.title)} (${fmt}, ${kb} KB)` },
        { type: 'image', data: shot.data, mimeType: fmt === 'png' ? 'image/png' : 'image/jpeg' },
      ],
    };
  },
});

const inches = (what: string) => z.number().positive().max(200).optional().describe(what);
const margin = (side: string) => z.number().min(0).max(100).optional().describe(`${side} margin in inches (default 0.39, i.e. 1 cm)`);

const PDF_DEFAULTS = { paperWidth: 8.5, paperHeight: 11, margin: 0.3937 };
/** Obscura's render limit per captured bitmap (16 MiB pixels). */
const MAX_CAPTURE_PIXELS = 16 * 1024 * 1024;

/** A file-name-safe name for the capture resource URI. */
function captureName(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    if (host) return host;
  } catch {
    // not a URL
  }
  return 'page';
}

export const pdf = defineTool({
  name: 'browser_pdf',
  title: 'Save page as PDF',
  group: 'capture',
  description:
    'Print the current page to a PDF (print media, paginated) and return it as an embedded application/pdf resource. ' +
    'Obscura renders PDF pages as images, so the text is not selectable; use browser_snapshot or browser_markdown to read text.',
  inputSchema: z.object({
    landscape: z.boolean().optional().describe('Landscape orientation (default false)'),
    print_background: z.boolean().optional().describe('Include background colors and images (default false)'),
    scale: z.number().min(0.1).max(2).optional().describe('Content scale 0.1-2 (default 1)'),
    paper_width: inches('Paper width in inches (default 8.5, US Letter)'),
    paper_height: inches('Paper height in inches (default 11, US Letter)'),
    margin_top: margin('Top'),
    margin_bottom: margin('Bottom'),
    margin_left: margin('Left'),
    margin_right: margin('Right'),
  }),
  annotations: { ...READ_ONLY, openWorldHint: false, title: 'Save page as PDF' },
  handler: async (args, ctx) => {
    const tab = await ctx.tab();
    const width = args.paper_width ?? PDF_DEFAULTS.paperWidth;
    const height = args.paper_height ?? PDF_DEFAULTS.paperHeight;
    const m = {
      top: args.margin_top ?? PDF_DEFAULTS.margin,
      bottom: args.margin_bottom ?? PDF_DEFAULTS.margin,
      left: args.margin_left ?? PDF_DEFAULTS.margin,
      right: args.margin_right ?? PDF_DEFAULTS.margin,
    };
    // landscape swaps the paper dimensions
    const pageWidth = args.landscape ? height : width;
    const pageHeight = args.landscape ? width : height;
    if (m.left + m.right >= pageWidth) {
      throw new ToolError(`margin_left + margin_right (${+(m.left + m.right).toFixed(3)} in) must be less than the page width (${pageWidth} in)`);
    }
    if (m.top + m.bottom >= pageHeight) {
      throw new ToolError(`margin_top + margin_bottom (${+(m.top + m.bottom).toFixed(3)} in) must be less than the page height (${pageHeight} in)`);
    }

    const info = await tab.pageInfo();
    // stay below TOOL_TIMEOUT_MS so a slow render ends with this tool's own error
    const timeoutMs = Math.max(5_000, Math.min(120_000, ctx.config.browser.toolTimeoutMs - 2_000));
    let res: { data?: string };
    try {
      res = await tab.send<{ data?: string }>(
        'Page.printToPDF',
        {
          transferMode: 'ReturnAsBase64',
          landscape: Boolean(args.landscape),
          printBackground: Boolean(args.print_background),
          scale: args.scale ?? 1,
          paperWidth: width,
          paperHeight: height,
          marginTop: m.top,
          marginBottom: m.bottom,
          marginLeft: m.left,
          marginRight: m.right,
        },
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof CdpTimeoutError) {
        throw new ToolError(`Could not create a PDF of ${info.url} within ${Math.round(timeoutMs / 1000)} s; the page may be too long. Try a smaller scale or paper size.`);
      }
      if (err instanceof CdpError) throw new ToolError(`Could not create a PDF of ${info.url}: ${err.message}`);
      throw err;
    }
    if (!res.data) throw new ToolError(`Could not create a PDF of ${info.url}: the browser returned no data`);
    const bytes = Buffer.from(res.data, 'base64');
    const pages = bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
    const size = bytes.length < 1024 * 1024 ? `${Math.max(1, Math.round(bytes.length / 1024))} KB` : `${(bytes.length / 1024 / 1024).toFixed(1)} MB`;
    const uri = `obscura://capture/${captureName(info.url)}.pdf`;
    const layout = `${pageWidth}x${pageHeight} in${args.landscape ? ', landscape' : ''}`;
    return {
      content: [
        {
          type: 'text',
          text: `PDF of ${info.url} — ${JSON.stringify(info.title)} (${pages ? `${pages} page(s), ` : ''}${size}, ${layout}) attached as ${uri}`,
        },
        { type: 'resource', resource: { uri, mimeType: 'application/pdf', blob: res.data } },
      ],
    };
  },
});

export const setViewport = defineTool({
  name: 'browser_set_viewport',
  title: 'Set viewport size',
  group: 'capture',
  description:
    'Resize the active tab\'s viewport (CSS pixels), e.g. 390x844 to check a phone-width layout. The page reflows and later screenshots use this size. ' +
    'Only the active tab changes; new tabs start at the default size.',
  inputSchema: z.object({
    width: z.number().int().min(100).max(7680).describe('Viewport width in CSS pixels (100-7680)'),
    height: z.number().int().min(100).max(4320).describe('Viewport height in CSS pixels (100-4320)'),
  }),
  annotations: { ...LOCAL_STATE, title: 'Set viewport size' },
  handler: async ({ width, height }, ctx) => {
    const tab = await ctx.tab();
    try {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    } catch (err) {
      if (err instanceof CdpError) throw new ToolError(`Could not resize the viewport: ${err.message}`);
      throw err;
    }
    const info = await tab.pageInfo();
    let text = `Viewport of ${tab.id} set to ${width}x${height}.`;
    if (info.innerWidth !== width || info.innerHeight !== height) {
      text += ` Note: the page reports window.innerWidth x innerHeight = ${info.innerWidth}x${info.innerHeight}.`;
    }
    if (width * height > MAX_CAPTURE_PIXELS) {
      text +=
        ` Warning: ${width}x${height} is more than 16 megapixels, the most Obscura can render, so browser_screenshot and the dashboard live view ` +
        'cannot capture this viewport (the page layout still uses it).';
    }
    return textResult(text);
  },
});

export default [screenshot, pdf, setViewport];
