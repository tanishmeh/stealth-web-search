/**
 * Masking of known secret values (the host's secret answers to a sub-agent, such as one-time codes)
 * wherever a run is logged or shown: they are replaced with [REDACTED] by value, not by field name.
 */

export const REDACTED = '[REDACTED]';

/**
 * What to mask for a secret answer: the whole answer and the code-like parts of it, because the agent
 * types just the code when the host answers in a sentence ("The code is 482 913." → "482913"). Short
 * answers (yes, no) and plain words are not masked by value: they would hide every such word in the logs.
 */
export function secretParts(answer: string): string[] {
  const out = new Set<string>();
  const whole = answer.trim();
  if (whole.length >= 4) out.add(whole);
  // tokens with a digit, as given and without dashes: 482913, K7Q2-Z9X4 and K7Q2Z9X4
  for (const m of whole.matchAll(/[A-Za-z0-9][A-Za-z0-9-]{3,}/g)) {
    const token = m[0].replace(/-+$/, '');
    if (token.length < 4 || !/\d/.test(token)) continue;
    out.add(token);
    out.add(token.replace(/-/g, ''));
  }
  // digit groups split by spaces or dashes, as given and as typed without them: "482 913" and 482913
  for (const m of whole.matchAll(/\d[\d\s-]{2,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 4) continue;
    out.add(m[0]);
    out.add(digits);
  }
  return [...out];
}

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
