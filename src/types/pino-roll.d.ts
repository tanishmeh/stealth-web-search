declare module 'pino-roll' {
  import type { Writable } from 'node:stream';

  interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: 'daily' | 'hourly' | number;
    extension?: string;
    symlink?: boolean;
    mkdir?: boolean;
    dateFormat?: string;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    sync?: boolean;
  }

  export default function roll(options: PinoRollOptions): Promise<Writable & { flushSync?: () => void; end: () => void }>;
}
