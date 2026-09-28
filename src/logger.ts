import { EventEmitter } from 'node:events';
import { accessSync, constants, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger, type StreamEntry } from 'pino';
import pretty from 'pino-pretty';
import roll from 'pino-roll';
import type { Config } from './config.ts';

export type { Logger } from 'pino';

export interface LogRecord {
  time: string;
  level: number;
  levelName: string;
  component?: string;
  msg: string;
  [key: string]: unknown;
}

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function parseLine(line: string): LogRecord | null {
  try {
    const rec = JSON.parse(line) as LogRecord;
    rec.levelName = LEVEL_NAMES[rec.level] ?? String(rec.level);
    return rec;
  } catch {
    return null; // never let the dashboard tap break logging
  }
}

/**
 * In-process tap on the log stream. The dashboard subscribes to it so that the
 * "Logs" panel shows exactly what is written to stdout / the log file.
 *
 * Lines arrive as the JSON text pino wrote. While nobody listens for 'record' events (no dashboard
 * viewer is connected) they are kept as text and only parsed when read (a viewer connects and gets
 * the history): most debug lines are never shown, so they are never parsed.
 */
export class LogTap extends EventEmitter {
  /**
   * Ring of the newest entries; an entry is a line's text until it is parsed. A ring, because
   * trimming an array from the front (splice) moves every element: ~3-6 µs per log line at 2000.
   */
  private readonly entries: Array<LogRecord | string> = [];
  /** Index of the oldest entry once the ring is full (0 until then). */
  private oldest = 0;
  private readonly capacity: number;
  constructor(capacity = 2000) {
    super();
    this.capacity = capacity;
  }

  /** Every kept record, oldest first. */
  get buffer(): LogRecord[] {
    return this.recent(this.capacity);
  }

  /** The last `count` records, oldest first. */
  recent(count: number): LogRecord[] {
    const size = this.entries.length;
    const records: LogRecord[] = [];
    for (let k = Math.max(0, size - count); k < size; k++) {
      const i = (this.oldest + k) % size;
      let entry = this.entries[i];
      if (typeof entry === 'string') {
        const rec = parseLine(entry);
        if (!rec) continue;
        this.entries[i] = entry = rec;
      }
      records.push(entry);
    }
    return records;
  }

  push(rec: LogRecord): void {
    this.keep(rec);
    this.emit('record', rec);
  }

  /** One line of JSON as written to the log; parsed right away only when someone listens. */
  pushLine(line: string): void {
    if (this.listenerCount('record') === 0) {
      this.keep(line);
      return;
    }
    const rec = parseLine(line);
    if (!rec) return;
    try {
      this.push(rec);
    } catch {
      // never let the dashboard tap break logging
    }
  }

  private keep(entry: LogRecord | string): void {
    if (this.entries.length < this.capacity) {
      this.entries.push(entry);
      return;
    }
    this.entries[this.oldest] = entry;
    this.oldest = (this.oldest + 1) % this.capacity;
  }
}

export interface LoggingHandle {
  logger: Logger;
  tap: LogTap;
  logFile: string;
  flush: () => Promise<void>;
}

export async function createLogging(config: Config): Promise<LoggingHandle> {
  const { log } = config;
  try {
    mkdirSync(log.dir, { recursive: true }); // pino-roll's symlink creation races without this
  } catch {
    // reported below, when the file stream cannot be opened
  }

  const levelValue = (l: string) => (l === 'silent' ? Infinity : pino.levels.values[l]);
  const tap = new LogTap();
  const tapLevel = 'debug';

  const tapStream = new Writable({
    decodeStrings: false, // pino writes strings: no round trip through a Buffer
    write(chunk: string | Buffer, _enc, cb) {
      for (const line of (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).split('\n')) {
        if (line) tap.pushLine(line);
      }
      cb();
    },
  });

  const logFile = path.join(log.dir, 'stealth-web-search.log');
  // A log directory the server cannot write to (e.g. a ./logs bind mount owned by another user on a
  // Linux host) must not stop the server: log to stdout only and say so.
  let fileStream: Awaited<ReturnType<typeof roll>> | null = null;
  if (log.fileLevel !== 'silent') {
    let stream: Awaited<ReturnType<typeof roll>> | null = null;
    try {
      mkdirSync(log.dir, { recursive: true });
      accessSync(log.dir, constants.W_OK);
      stream = await roll({
        file: logFile,
        size: log.fileMaxSize,
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        limit: { count: log.fileMaxFiles },
        mkdir: true,
        symlink: true,
      });
      // the file opens asynchronously: an existing file we cannot write (e.g. today's log, created by
      // another user) only fails here
      const opening = stream;
      await new Promise<void>((resolve, reject) => {
        if ((opening as any).fd >= 0) return resolve();
        opening.once('ready', () => resolve());
        opening.once('error', reject);
      });
      fileStream = stream;
    } catch (err) {
      if (stream) {
        // pino-roll already scheduled its rotation on this stream: closing it cancels that, so the
        // failed stream cannot throw later (at the next rotation) with nobody listening
        stream.on('error', () => undefined);
        stream.emit('close');
      }
      process.stderr.write(
        `stealth-web-search: cannot write log files to ${log.dir} (${(err as Error)?.message ?? err}); logging to stdout only. ` +
          `Make the directory and its files writable by the server's user (in Docker: uid 1000, e.g. \`sudo chown -R 1000:1000 logs\`).\n`,
      );
      fileStream = null;
    }
  }
  // The underlying SonicBoom stream emits 'error' (e.g. the log directory was removed at runtime, so
  // rotation fails). Without a listener that becomes an uncaught exception that would crash the
  // process (and orphan the browser). Logging must degrade, not crash: warn to stderr and try to
  // recreate the directory so the next write can recover.
  fileStream?.on('error', (err: Error) => {
    process.stderr.write(`stealth-web-search: log file stream error: ${err?.message ?? String(err)}\n`);
    try {
      mkdirSync(log.dir, { recursive: true });
    } catch {
      // best effort; keep running on the other streams
    }
  });

  const stdoutStream =
    log.format === 'pretty'
      ? pretty({
          colorize: process.stdout.isTTY,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{if component}[{component}] {end}{msg}',
          destination: 1,
          sync: true,
        })
      : pino.destination({ dest: 1, sync: false });

  const streams: StreamEntry[] = [];
  if (log.level !== 'silent') streams.push({ level: log.level as pino.Level, stream: stdoutStream });
  if (fileStream) {
    // A file stream that lost its file (fd -1 after an error) throws on write: drop lines instead,
    // until rotation or recovery reopens it.
    const file = fileStream;
    const guarded = {
      write(chunk: string): boolean {
        if (typeof (file as any).fd === 'number' && (file as any).fd < 0) return true;
        try {
          return file.write(chunk);
        } catch {
          return true;
        }
      },
      flushSync(): void {
        try {
          (file as any).flushSync?.();
        } catch {
          // nothing to flush into
        }
      },
    };
    streams.push({ level: log.fileLevel as pino.Level, stream: guarded as any });
  }
  streams.push({ level: tapLevel, stream: tapStream });

  const minLevel = [log.level, fileStream ? log.fileLevel : 'silent', tapLevel]
    .filter((l) => l !== 'silent')
    .sort((a, b) => levelValue(a) - levelValue(b))[0];

  const logger = pino(
    {
      name: 'stealth-web-search',
      level: minLevel ?? 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid },
      formatters: { level: (label, number) => ({ level: number, levelName: label }) },
      redact: {
        paths: [
          'headers.authorization',
          'headers.cookie',
          'req.headers.authorization',
          'req.headers.cookie',
          '*.headers.authorization',
          '*.headers.cookie',
          'authToken',
        ],
        censor: '[REDACTED]',
      },
      serializers: { err: pino.stdSerializers.err },
    },
    pino.multistream(streams, { dedupe: false }),
  );

  const flush = () =>
    new Promise<void>((resolve) => {
      try {
        logger.flush();
      } catch {
        // ignore
      }
      setTimeout(resolve, 150);
    });

  // pino-roll writes stealth-web-search.<date>.<n>.log and keeps current.log pointing at it
  return { logger, tap, logFile: path.join(log.dir, 'current.log'), flush };
}
