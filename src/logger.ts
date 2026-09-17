import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
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

/**
 * In-process tap on the log stream. The dashboard subscribes to it so that the
 * "Logs" panel shows exactly what is written to stdout / the log file.
 */
export class LogTap extends EventEmitter {
  readonly buffer: LogRecord[] = [];
  private readonly capacity: number;
  constructor(capacity = 2000) {
    super();
    this.capacity = capacity;
  }
  push(rec: LogRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    this.emit('record', rec);
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
  mkdirSync(log.dir, { recursive: true }); // pino-roll's symlink creation races without this

  const levelValue = (l: string) => (l === 'silent' ? Infinity : pino.levels.values[l]);
  const tap = new LogTap();
  const tapLevel = 'debug';

  const tapStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as LogRecord;
          rec.levelName = LEVEL_NAMES[rec.level] ?? String(rec.level);
          tap.push(rec);
        } catch {
          // never let the dashboard tap break logging
        }
      }
      cb();
    },
  });

  const logFile = path.join(log.dir, 'stealth-browser-mcp.log');
  const fileStream = await roll({
    file: logFile,
    size: log.fileMaxSize,
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    limit: { count: log.fileMaxFiles },
    mkdir: true,
    symlink: true,
  });
  // The underlying SonicBoom stream emits 'error' (e.g. the log directory was removed at runtime, so
  // rotation fails). Without a listener that becomes an uncaught exception that would crash the
  // process (and orphan the browser). Logging must degrade, not crash: warn to stderr and try to
  // recreate the directory so the next write can recover.
  fileStream.on('error', (err: Error) => {
    process.stderr.write(`stealth-browser-mcp: log file stream error: ${err?.message ?? String(err)}\n`);
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
  if (log.fileLevel !== 'silent') streams.push({ level: log.fileLevel as pino.Level, stream: fileStream });
  streams.push({ level: tapLevel, stream: tapStream });

  const minLevel = [log.level, log.fileLevel, tapLevel]
    .filter((l) => l !== 'silent')
    .sort((a, b) => levelValue(a) - levelValue(b))[0];

  const logger = pino(
    {
      name: 'stealth-browser-mcp',
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

  // pino-roll writes stealth-browser-mcp.<date>.<n>.log and keeps current.log pointing at it
  return { logger, tap, logFile: path.join(log.dir, 'current.log'), flush };
}
