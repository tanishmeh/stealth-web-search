// Pure helpers used by the dashboard page. No DOM access, so they are unit-tested in Node.

/**
 * The part of a history snapshot (from a 'hello' event) that is newer than what
 * `buffer` already holds, so a reconnect or pause/resume never shows a row twice.
 * Histories and live events are both in time order; entries sharing the newest
 * timestamp are told apart by `keyOf`.
 *
 * @template B, T
 * @param {B[]} buffer   what the page already shows (oldest first)
 * @param {T[]} items    history snapshot (oldest first)
 * @param {(item: T) => string} timeOf  ISO timestamp of an entry
 * @param {(item: T) => string} keyOf   identity of an entry within one timestamp
 * @param {(entry: B) => T} [unwrap]    maps a buffer element back to the raw entry
 * @returns {T[]}
 */
export function appendNewTimed(buffer, items, timeOf, keyOf, unwrap = (entry) => entry) {
  if (!buffer.length) return items;
  const lastTime = timeOf(unwrap(buffer[buffer.length - 1]));
  const seen = new Set();
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = unwrap(buffer[i]);
    if (timeOf(entry) !== lastTime) break;
    seen.add(keyOf(entry));
  }
  return items.filter((item) => {
    const t = timeOf(item);
    return t > lastTime || (t === lastTime && !seen.has(keyOf(item)));
  });
}

/**
 * Estimate how far the browser clock is ahead of the server clock (ms), from the
 * server's `now` timestamp and the local time the message arrived. Delivery delay
 * only ever makes the server look further behind, so small changes keep the lower
 * estimate; a jump of more than `stepMs` (clock adjusted, other server) replaces it.
 *
 * @param {number | null} previous  current estimate, or null
 * @param {string | undefined} serverNowIso
 * @param {number} receivedAt  Date.now() when the message arrived
 * @param {number} [stepMs]
 * @returns {number | null}
 */
export function updateClockSkew(previous, serverNowIso, receivedAt, stepMs = 2000) {
  const serverNow = Date.parse(typeof serverNowIso === 'string' ? serverNowIso : '');
  if (!Number.isFinite(serverNow)) return previous;
  const sample = receivedAt - serverNow;
  if (previous === null || !Number.isFinite(previous) || Math.abs(sample - previous) > stepMs) return sample;
  return Math.min(previous, sample);
}
