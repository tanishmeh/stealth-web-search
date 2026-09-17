import { createHash } from 'node:crypto';

/**
 * Make arbitrary payloads safe and readable for logs:
 *  - long strings are truncated (with the original length recorded)
 *  - base64 image/pdf blobs are replaced by a size + short sha256 fingerprint
 *  - deep / cyclic structures are bounded
 *
 * Nothing is dropped silently: every truncation says how much was cut.
 */
export interface SummarizeOptions {
  maxString: number;
  /** Lower-case key names whose values are replaced by "[REDACTED]" wherever they appear. */
  redactKeys?: ReadonlySet<string>;
  maxDepth?: number;
  maxArrayItems?: number;
  maxKeys?: number;
}

const BINARY_KEYS = new Set(['data', 'blob']);
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export function fingerprint(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4);
  const sha = createHash('sha256').update(base64).digest('hex').slice(0, 12);
  return `<binary ${bytes} bytes sha256:${sha}>`;
}

export function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

export function summarize(value: unknown, opts: SummarizeOptions): unknown {
  const maxDepth = opts.maxDepth ?? 8;
  const maxArrayItems = opts.maxArrayItems ?? 50;
  const maxKeys = opts.maxKeys ?? 100;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number, key: string | undefined): unknown => {
    if (key !== undefined && opts.redactKeys?.has(key.toLowerCase()) && v !== null && v !== undefined && v !== '') return '[REDACTED]';
    if (typeof v === 'string') {
      if (key && BINARY_KEYS.has(key) && v.length > 256 && BASE64_RE.test(v.slice(0, 512))) return fingerprint(v);
      return truncateString(v, opts.maxString);
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '<circular>';
    if (depth >= maxDepth) return Array.isArray(v) ? `<array(${v.length})>` : '<object>';
    seen.add(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, maxArrayItems).map((item) => walk(item, depth + 1, undefined));
      if (v.length > maxArrayItems) items.push(`…(+${v.length - maxArrayItems} items)`);
      return items;
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (const [k, val] of entries.slice(0, maxKeys)) out[k] = walk(val, depth + 1, k);
    if (entries.length > maxKeys) out['…'] = `+${entries.length - maxKeys} keys`;
    return out;
  };

  return walk(value, 0, undefined);
}

/** HTTP headers that carry credentials. */
export const SECRET_HEADER_KEYS: ReadonlySet<string> = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key']);
/** Header keys plus cookie values (for Network/Storage cookie commands). */
export const COOKIE_PAYLOAD_KEYS: ReadonlySet<string> = new Set([...SECRET_HEADER_KEYS, 'value']);

/** One-line human preview of an MCP tool result, used by the dashboard and logs. */
export function previewToolResult(result: { content?: Array<Record<string, unknown>>; isError?: boolean }, max = 600): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string')
      parts.push(`[image ${String(block.mimeType)} ${Math.round((block.data.length * 3) / 4 / 1024)} KB]`);
    else if (block.type === 'resource') {
      const r = block.resource as Record<string, unknown> | undefined;
      const size = typeof r?.blob === 'string' ? `${Math.round((r.blob.length * 3) / 4 / 1024)} KB` : '';
      parts.push(`[resource ${String(r?.mimeType ?? '')} ${size}]`);
    } else parts.push(`[${String(block.type)}]`);
  }
  return truncateString(parts.join('\n'), max);
}
