#!/usr/bin/env node
// Download the Obscura release binary for this machine into ./.obscura/ (for running
// the server or tests without Docker). The Docker image downloads its own copy.
//
// Usage: node scripts/download-obscura.mjs [--version v0.2.2] [--variant stealth|default] [--force]

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, '.obscura');
const REPO = 'h4ckf0r0day/obscura';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const version = opt('version', process.env.OBSCURA_VERSION || readPinnedVersion());
const variant = opt('variant', process.env.OBSCURA_VARIANT || 'stealth');
const force = args.includes('--force');

function readPinnedVersion() {
  // Keep local development on the same Obscura release as the Docker image.
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  return /ARG OBSCURA_VERSION=(\S+)/.exec(dockerfile)?.[1] ?? 'v0.2.2';
}

const archMap = { arm64: 'aarch64', x64: 'x86_64' };
const osMap = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const arch = archMap[process.arch];
const os = osMap[process.platform];
if (!arch || !os) {
  console.error(`Unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}
const suffix = variant === 'stealth' ? '-stealth' : '';
const ext = os === 'windows' ? 'zip' : 'tar.gz';
const asset = `obscura-${arch}-${os}${suffix}.${ext}`;
const binName = os === 'windows' ? 'obscura.exe' : 'obscura';
const marker = path.join(DEST, 'VERSION');

if (!force && existsSync(path.join(DEST, binName)) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === `${version} ${asset}`) {
  console.log(`Obscura ${version} (${asset}) already present in .obscura/`);
  process.exit(0);
}

console.log(`Looking up ${asset} in ${REPO} ${version}…`);
const apiHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'stealth-browser-mcp' };
if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; // avoids API rate limits in CI
const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${version}`, { headers: apiHeaders });
if (!releaseRes.ok) {
  console.error(`GitHub API returned ${releaseRes.status} for release ${version}`);
  process.exit(1);
}
const release = await releaseRes.json();
const meta = release.assets.find((a) => a.name === asset);
if (!meta) {
  console.error(`Asset ${asset} not found in release ${version}. Available: ${release.assets.map((a) => a.name).join(', ')}`);
  process.exit(1);
}
const expected = String(meta.digest || '').replace(/^sha256:/, '');

mkdirSync(DEST, { recursive: true });
const archive = path.join(DEST, asset);
console.log(`Downloading ${meta.browser_download_url} (${Math.round(meta.size / 1024 / 1024)} MB)…`);
const res = await fetch(meta.browser_download_url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

const actual = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(archive).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
if (expected && actual !== expected) {
  rmSync(archive, { force: true });
  console.error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  process.exit(1);
}
console.log(expected ? `sha256 verified: ${actual}` : `sha256 (no digest published to compare): ${actual}`);

if (ext === 'zip') execFileSync('tar', ['-xf', archive, '-C', DEST], { stdio: 'inherit' });
else execFileSync('tar', ['-xzf', archive, '-C', DEST], { stdio: 'inherit' });
rmSync(archive, { force: true });
if (os !== 'windows') chmodSync(path.join(DEST, binName), 0o755);
if (os === 'macos') {
  try {
    execFileSync('xattr', ['-d', 'com.apple.quarantine', path.join(DEST, binName)], { stdio: 'ignore' });
  } catch {
    // attribute not present
  }
}
writeFileSync(marker, `${version} ${asset}\n`);
const out = execFileSync(path.join(DEST, binName), ['--version']).toString().trim();
console.log(`Installed ${out} → .obscura/${binName}`);
