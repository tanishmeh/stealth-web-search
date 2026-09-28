import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../../src/config.ts';
import { Hub, type HubEvent } from '../../src/dashboard/hub.ts';
import { LogTap, createLogging } from '../../src/logger.ts';

const line = (i: number, level = 20) => JSON.stringify({ level, levelName: level === 30 ? 'info' : 'debug', time: `2026-09-28T00:00:00.${String(i).padStart(3, '0')}Z`, msg: `m${i}` });

describe('LogTap', () => {
  test('keeps the newest records in order, parsing lines only when read', () => {
    const tap = new LogTap(5);
    for (let i = 0; i < 12; i++) tap.pushLine(line(i, i === 11 ? 30 : 20));
    const all = tap.buffer;
    assert.deepEqual(
      all.map((r) => r.msg),
      ['m7', 'm8', 'm9', 'm10', 'm11'],
    );
    assert.equal(all[4].levelName, 'info');
    assert.equal(all[0].levelName, 'debug');
    assert.deepEqual(
      tap.recent(2).map((r) => r.msg),
      ['m10', 'm11'],
    );
    assert.equal(tap.recent(2)[0], all[3], 'a line is parsed once; later reads return the same record');
    assert.deepEqual(
      tap.recent(50).map((r) => r.msg),
      ['m7', 'm8', 'm9', 'm10', 'm11'],
    );
  });

  test('emits records to listeners at once, and mixes them in order with lines kept as text', () => {
    const tap = new LogTap(4);
    const seen: string[] = [];
    tap.pushLine(line(1));
    tap.pushLine(line(2));
    const listener = (rec: { msg: string }) => seen.push(rec.msg);
    tap.on('record', listener);
    tap.pushLine(line(3));
    tap.pushLine(line(4));
    tap.off('record', listener);
    tap.pushLine(line(5));
    tap.push({ time: 't', level: 40, levelName: 'warn', msg: 'm6' });
    assert.deepEqual(seen, ['m3', 'm4']);
    assert.deepEqual(
      tap.buffer.map((r) => r.msg),
      ['m3', 'm4', 'm5', 'm6'],
    );
  });

  test('never lets a bad line or a failing listener break logging', () => {
    const tap = new LogTap(10);
    tap.pushLine('not json');
    tap.on('record', () => {
      throw new Error('listener failed');
    });
    tap.pushLine('{also not json');
    assert.doesNotThrow(() => tap.pushLine(line(1)));
    assert.deepEqual(
      tap.buffer.map((r) => r.msg),
      ['m1'],
    );
  });
});

describe('Hub and the log tap', () => {
  test('listens to the tap only while a viewer is subscribed; history includes lines logged meanwhile', () => {
    const tap = new LogTap();
    const hub = new Hub(tap);
    assert.equal(tap.listenerCount('record'), 0);
    tap.pushLine(line(1));

    const a: HubEvent[] = [];
    const b: HubEvent[] = [];
    const offA = hub.subscribe((e) => a.push(e), false);
    const offB = hub.subscribe((e) => b.push(e), true);
    assert.equal(tap.listenerCount('record'), 1);
    tap.pushLine(line(2));
    assert.deepEqual(
      a.filter((e) => e.type === 'log').map((e) => (e.data as { msg: string }).msg),
      ['m2'],
    );
    assert.equal(b.find((e) => e.type === 'log')?.data, a.find((e) => e.type === 'log')?.data, 'one record object for every viewer');
    offA();
    offA();
    assert.equal(tap.listenerCount('record'), 1);
    offB();
    assert.equal(tap.listenerCount('record'), 0);
    tap.pushLine(line(3));
    assert.deepEqual(
      hub.history().logs.map((r) => r.msg),
      ['m1', 'm2', 'm3'],
    );
  });
});

describe('createLogging', () => {
  test('the dashboard tap sees exactly the records written to the log file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbm-logging-test-'));
    try {
      const { logger, tap, logFile, flush } = await createLogging(loadConfig({ LOG_DIR: dir, LOG_LEVEL: 'silent', LOG_FILE_LEVEL: 'debug', LOG_FORMAT: 'json' }));
      const hub = new Hub(tap);
      const live: unknown[] = [];
      const cdp = logger.child({ component: 'cdp' });
      cdp.debug({ dir: 'out', id: 1, method: 'Runtime.evaluate', params: { expression: 'document.title', nested: { a: [1, 2, 3] } } }, 'CDP → Runtime.evaluate');
      cdp.info({ headers: { authorization: 'Bearer secret', accept: '*/*' } }, 'unicode: Café 東京 \u{1F680} "quoted" \\ back');
      const off = hub.subscribe((e) => e.type === 'log' && live.push(e.data), false);
      cdp.warn({ err: new Error('boom') }, 'while a viewer watches');
      logger.trace('below every level: not logged');
      off();
      cdp.debug({ n: 7 }, 'after the viewer left');
      await flush();

      const fileRecords = readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.equal(fileRecords.length, 4);
      assert.deepEqual(tap.buffer, fileRecords, 'same records, same order, levelName included');
      assert.equal(fileRecords[1].headers.authorization, '[REDACTED]');
      assert.deepEqual(live, [fileRecords[2]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
