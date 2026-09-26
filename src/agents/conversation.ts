import type { ChatMessage } from './llm.ts';

/**
 * Conversation bookkeeping for sub-agents: argument parsing, result truncation and keeping the
 * transcript inside the context budget (AGENT_CONTEXT_TOKENS, 64k by default).
 */

/** Parse tool-call arguments, tolerating code fences and junk around one JSON object. */
export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '' || text === 'null') return { ok: true, value: {} };
  const attempt = (s: string) => {
    const v = JSON.parse(s);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('arguments must be a JSON object');
    return v as Record<string, unknown>;
  };
  try {
    return { ok: true, value: attempt(text) };
  } catch (err) {
    const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: attempt(unfenced.slice(start, end + 1)) };
      } catch {
        // fall through
      }
    }
    return { ok: false, error: (err as Error).message };
  }
}

export function truncateText(text: string, max: number, hint = 'Use more specific tools or options (selector, max_chars, filter) to read the rest.'): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} characters. ${hint}]`;
}

/**
 * Characters per token, measured from the endpoint's reported prompt tokens. Starts
 * conservative (browser text and JSON tokenize densely) and follows the measurements.
 */
export class TokenMeter {
  private ratio = 3.0;

  get charsPerToken(): number {
    return this.ratio;
  }

  /** Record a request of `chars` characters that the endpoint counted as `promptTokens`. */
  observe(chars: number, promptTokens: number): void {
    if (!(promptTokens > 200) || !(chars > 0)) return;
    const measured = Math.min(6, Math.max(1.5, chars / promptTokens));
    // lean towards the lower (safer) estimate
    this.ratio = Math.min(measured, this.ratio * 0.5 + measured * 0.5);
  }

  tokens(chars: number): number {
    return Math.ceil(chars / this.ratio);
  }
}

export function messageChars(m: ChatMessage): number {
  // role, ids and JSON punctuation
  let n = 16 + (m.content?.length ?? 0) + (m.tool_call_id?.length ?? 0);
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

export function transcriptChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0);
}

const KEEP_RECENT_TURNS = 3;
const OLD_RESULT_CHARS = 1_500;
const MIN_RESULT_CHARS = 300;

export interface CompactionReport {
  shortened: number;
  droppedSteps: number;
  beforeChars: number;
  afterChars: number;
}

/**
 * Shrink the transcript until it fits `maxChars`:
 * 1. shorten older tool results (those of the latest few turns stay whole),
 * 2. shorten them further (only the latest turn's results stay whole),
 * 3. drop the oldest steps (an assistant turn with all of its tool results) after the task,
 *    leaving a note, and `pinned` text (the agent's notes) so nothing it saved is lost.
 * messages[0] (system) and messages[1] (the task) are always kept.
 */
export function compactTranscript(messages: ChatMessage[], maxChars: number, pinned: () => string): CompactionReport {
  const beforeChars = transcriptChars(messages);
  const report: CompactionReport = { shortened: 0, droppedSteps: 0, beforeChars, afterChars: beforeChars };
  const total = () => transcriptChars(messages);
  if (beforeChars <= maxChars) return report;

  // results of the latest `keepTurns` assistant turns stay whole
  const olderResults = (keepTurns: number) => {
    const turns = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
    const cutoff = turns.length > keepTurns ? turns[turns.length - keepTurns] : 0;
    return messages.flatMap((m, i) => (m.role === 'tool' && i < cutoff ? [i] : []));
  };
  for (const [limit, keepTurns] of [
    [OLD_RESULT_CHARS, KEEP_RECENT_TURNS],
    [MIN_RESULT_CHARS, 1],
  ] as const) {
    for (const i of olderResults(keepTurns)) {
      if (total() <= maxChars) break;
      const m = messages[i];
      if (typeof m.content === 'string' && m.content.length > limit + 120) {
        m.content = `${m.content.slice(0, limit)}\n...[older result shortened to save context]`;
        report.shortened++;
      }
    }
    if (total() <= maxChars) break;
  }

  // Drop whole steps, oldest first, keeping the last two steps and any trailing user messages.
  // Room is kept for the note that replaces them (unless an earlier note is already counted).
  const hasNote = () => messages.some((m) => m.role === 'user' && m.content?.startsWith('[Context note]'));
  const reserve = hasNote() ? pinned().length + 50 : pinned().length + 300;
  while (total() + (report.droppedSteps > 0 || !hasNote() ? reserve : 0) > maxChars) {
    const first = messages.findIndex((m, i) => i >= 2 && m.role === 'assistant');
    if (first < 0) break;
    let end = first + 1;
    while (end < messages.length && messages[end].role === 'tool') end++;
    const remainingSteps = messages.slice(end).filter((m) => m.role === 'assistant').length;
    if (remainingSteps < 2) break;
    messages.splice(first, end - first);
    report.droppedSteps++;
  }
  if (report.droppedSteps > 0) {
    const noteIdx = messages.findIndex((m) => m.role === 'user' && m.content?.startsWith('[Context note]'));
    const dropped = report.droppedSteps + (noteIdx >= 0 ? Number(/(\d+) earlier step/.exec(messages[noteIdx].content ?? '')?.[1] ?? 0) : 0);
    const notes = pinned().trim();
    const note: ChatMessage = {
      role: 'user',
      content:
        `[Context note] ${dropped} earlier step(s) were removed to fit the context window. ` +
        'Continue from the current browser state; do not repeat work that is already done.' +
        (notes ? `\nYour saved notes so far:\n${notes}` : ''),
    };
    if (noteIdx >= 0) messages.splice(noteIdx, 1);
    const insertAt = messages.findIndex((m, i) => i >= 2 && m.role === 'assistant');
    messages.splice(insertAt < 0 ? messages.length : insertAt, 0, note);
  }
  report.afterChars = total();
  return report;
}
