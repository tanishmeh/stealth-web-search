import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Plain browser module (no type declarations); load it by URL so it stays untyped.
const lib = await import(new URL('../../src/dashboard/public/lib.js', import.meta.url).href);
const { appendNewTimed, updateClockSkew } = lib;

const logRecord = (time: string, msg: string, extra: Record<string, unknown> = {}) => ({ time, level: 30, levelName: 'info', component: 'http', msg, ...extra });

describe('dashboard appendNewTimed', () => {
  test('a history snapshot after a reconnect adds only records the page has not shown (log buffer of wrappers)', () => {
    const history1 = [logRecord('2026-09-17T07:00:00.000Z', 'a'), logRecord('2026-09-17T07:00:01.000Z', 'b')];
    // the dashboard keeps log records wrapped as { r, seq }; the raw record is compared
    const buffer = history1.map((r, i) => ({ r, seq: i + 1, hay: null }));
    const history2 = [...history1, logRecord('2026-09-17T07:00:02.000Z', 'c')];
    const added = appendNewTimed(buffer, history2, (r: any) => r.time, (r: any) => JSON.stringify(r), (rec: any) => rec.r);
    assert.deepEqual(
      added.map((r: any) => r.msg),
      ['c'],
    );
  });

  test('records sharing the newest timestamp are told apart by key', () => {
    const t = '2026-09-17T07:00:05.123Z';
    const buffer = [
      { at: '2026-09-17T07:00:04.000Z', text: 'old' },
      { at: t, text: 'same-ms one' },
    ];
    const history = [...buffer, { at: t, text: 'same-ms two' }, { at: '2026-09-17T07:00:06.000Z', text: 'new' }];
    const added = appendNewTimed(buffer, history, (e: any) => e.at, (e: any) => e.text);
    assert.deepEqual(
      added.map((e: any) => e.text),
      ['same-ms two', 'new'],
    );
  });

  test('an empty buffer takes the whole snapshot', () => {
    const items = [{ at: '2026-09-17T07:00:00.000Z' }];
    assert.equal(appendNewTimed([], items, (e: any) => e.at, () => ''), items);
  });
});

describe('dashboard updateClockSkew', () => {
  const server = Date.parse('2026-09-17T07:00:00.000Z');

  test('measures how far the browser clock is ahead of the server clock', () => {
    assert.equal(updateClockSkew(null, new Date(server).toISOString(), server + 90_000), 90_000);
    assert.equal(updateClockSkew(null, new Date(server).toISOString(), server - 30_000), -30_000);
  });

  test('keeps the lower estimate when a sample is only delayed in transit', () => {
    assert.equal(updateClockSkew(5_000, new Date(server).toISOString(), server + 5_400), 5_000);
    assert.equal(updateClockSkew(5_000, new Date(server).toISOString(), server + 4_800), 4_800);
  });

  test('follows a clock step and ignores missing or invalid timestamps', () => {
    assert.equal(updateClockSkew(5_000, new Date(server).toISOString(), server + 60_000), 60_000);
    assert.equal(updateClockSkew(5_000, undefined, server), 5_000);
    assert.equal(updateClockSkew(null, 'not a date', server), null);
  });
});
