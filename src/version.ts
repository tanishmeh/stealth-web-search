import { readFileSync } from 'node:fs';

function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'stealth-browser-mcp' && pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

export const SERVER_NAME = 'stealth-browser-mcp';
export const SERVER_VERSION = readVersion();
