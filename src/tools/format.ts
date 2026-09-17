import type { Tab } from '../browser/tab.ts';

export const DEFAULT_TEXT_LIMIT = 4000;

/** Truncate by Unicode code points, saying how much was cut. */
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}\n...(truncated, ${chars.length - maxChars} more chars)`;
}

export interface InteractiveItem {
  nid: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  label: string;
  visible: boolean;
  inViewport: boolean;
  disabled: boolean;
  href?: string;
  value?: string;
  checked?: boolean;
  placeholder?: string;
  options?: string[];
}

/**
 * One line per element, e.g.
 *   ref=e3    input[email]           "Email address" name="email" value=""
 * Refs are assigned on the tab so they can be passed to click/fill/type.
 */
export function formatInteractive(tab: Tab, items: InteractiveItem[]): string[] {
  return items.map((it) => {
    const ref = tab.assignRef(it.nid, it.tag, it.label, it.type);
    const kind = it.type ? `${it.tag}[${it.type}]` : it.role ? `${it.tag}[role=${it.role}]` : it.tag;
    const extras: string[] = [];
    if (it.name) extras.push(`name=${JSON.stringify(it.name)}`);
    if (it.href) extras.push(`href=${JSON.stringify(shortUrl(it.href, tab.url))}`);
    if (it.value !== undefined) extras.push(`value=${JSON.stringify(it.value)}`);
    if (it.checked !== undefined) extras.push(it.checked ? 'checked' : 'unchecked');
    if (it.placeholder && it.placeholder !== it.label) extras.push(`placeholder=${JSON.stringify(it.placeholder)}`);
    if (it.options?.length) extras.push(`options=${JSON.stringify(it.options)}`);
    if (it.disabled) extras.push('disabled');
    if (!it.visible) extras.push('hidden');
    else if (!it.inViewport) extras.push('offscreen');
    return `ref=${ref.padEnd(5)} ${kind.padEnd(22)} ${JSON.stringify(it.label)}${extras.length ? ` ${extras.join(' ')}` : ''}`;
  });
}

/** Show same-origin URLs as paths to save tokens. */
export function shortUrl(href: string, base: string): string {
  try {
    const u = new URL(href);
    const b = new URL(base);
    if (u.origin === b.origin && (u.protocol === 'http:' || u.protocol === 'https:')) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // not a URL
  }
  return href;
}

export function formatStatus(status: number | null): string {
  return status === null ? '' : ` (HTTP ${status})`;
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Valid JSON that costs fewer tokens than `pretty`: values whose one-line form
 * fits within `width` characters stay on one line, arrays of primitives are
 * packed several per line, and everything else is indented by two spaces.
 */
export function compactJson(value: unknown, width = 100): string {
  // `prefix` is the length of what precedes the value on its line (`"key": `); +1 leaves room for a trailing comma
  const format = (v: unknown, indent: string, prefix = 0): string => {
    const flat = JSON.stringify(v);
    if (flat === undefined) return 'null';
    if (v === null || typeof v !== 'object' || typeof (v as { toJSON?: unknown }).toJSON === 'function' || indent.length + prefix + flat.length + 1 <= width) {
      return flat;
    }
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.every((item) => item === null || typeof item !== 'object')) {
        const lines: string[] = [];
        let line = '';
        for (const item of v) {
          const part = JSON.stringify(item) ?? 'null';
          if (line && inner.length + line.length + part.length + 3 > width) {
            lines.push(line);
            line = part;
          } else {
            line = line ? `${line}, ${part}` : part;
          }
        }
        lines.push(line);
        return `[\n${lines.map((l) => inner + l).join(',\n')}\n${indent}]`;
      }
      return `[\n${v.map((item) => inner + format(item, inner)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => JSON.stringify(val) !== undefined);
    return `{\n${entries.map(([k, val]) => `${inner}${JSON.stringify(k)}: ${format(val, inner, JSON.stringify(k).length + 2)}`).join(',\n')}\n${indent}}`;
  };
  return format(value, '');
}
