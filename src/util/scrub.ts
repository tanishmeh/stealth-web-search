/**
 * Masking of known secret values (the host's secret answers to a sub-agent, such as one-time codes)
 * wherever a run is logged or shown: they are replaced with [REDACTED] by value, not by field name.
 */

export const REDACTED = '[REDACTED]';

/** `text` with every occurrence of each secret replaced by [REDACTED] (longest first, so a secret inside another is hidden too). */
export function scrubText(text: string, secrets: ReadonlySet<string>): string {
  if (!secrets.size || !text) return text;
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** `value` with every string in it (in arrays and plain objects) passed through `scrub`; the same value when nothing changed. */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = scrubDeep(v, scrub);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = scrubDeep(v, scrub);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
