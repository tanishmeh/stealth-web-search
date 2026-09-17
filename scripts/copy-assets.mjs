#!/usr/bin/env node
// Copy non-TypeScript runtime assets (the dashboard's static files) into dist/.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'dashboard', 'public');
const to = path.join(root, 'dist', 'dashboard', 'public');
if (!existsSync(from)) {
  console.error(`missing ${from}`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied dashboard assets → ${path.relative(root, to)}`);
