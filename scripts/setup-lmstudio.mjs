#!/usr/bin/env node
/**
 * Add, update or remove the Stealth Browser MCP server in LM Studio's mcp.json.
 *
 *   npm run lmstudio:setup                       # add http://127.0.0.1:8931/mcp as "stealth-browser"
 *   npm run lmstudio:setup -- --token s3cret     # server started with AUTH_TOKEN
 *   npm run lmstudio:setup -- --print            # show the JSON and an "Add to LM Studio" deeplink only
 *   npm run lmstudio:setup -- --remove
 *
 * Other servers in the file are left untouched, a timestamped backup is written
 * next to the file before any change, and the result is 2-space indented JSON.
 * LM Studio watches the file and reloads it; no restart is needed.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_NAME = 'stealth-browser';
const DEFAULT_URL = 'http://127.0.0.1:8931/mcp';
const DEFAULT_TIMEOUT_MS = 180_000;

const USAGE = `Usage: node scripts/setup-lmstudio.mjs [options]

Adds the Stealth Browser MCP server to LM Studio's mcp.json (or updates it).

Options:
  --url <url>        MCP endpoint (default ${DEFAULT_URL})
  --name <name>      server key, lowercase kebab-case (default ${DEFAULT_NAME}; LM Studio plugin id mcp/<name>)
  --token <token>    add "Authorization: Bearer <token>" (the server's AUTH_TOKEN)
  --no-token         remove a previously configured Authorization header
  --timeout <ms>     tool call timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})
  --config <path>    mcp.json to edit (default $LMSTUDIO_HOME/mcp.json, else the LM Studio home
                     named in ~/.lmstudio-home-pointer, else ~/.lmstudio/mcp.json)
  --remove           remove the server entry
  --dry-run          show the resulting file without writing it
  --print            print the server JSON and an lmstudio://add_mcp deeplink; change nothing
  -h, --help`;

class UsageError extends Error {}

function fail(message, code = 1) {
  process.stderr.write(`setup-lmstudio: ${message}\n`);
  process.exit(code);
}

function parse() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        url: { type: 'string' },
        name: { type: 'string' },
        token: { type: 'string' },
        'no-token': { type: 'boolean' },
        timeout: { type: 'string' },
        config: { type: 'string' },
        remove: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        print: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const v = parsed.values;
  if (v.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const name = v.name ?? DEFAULT_NAME;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 100) {
    throw new UsageError(`--name must be lowercase kebab-case (letters, digits and single dashes), got "${name}". LM Studio derives the plugin id mcp/<name> from it.`);
  }

  const rawUrl = v.url ?? DEFAULT_URL;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError(`--url is not a valid URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError(`--url must use http or https, got "${rawUrl}"`);
  const warnings = [];
  if (url.hostname === 'localhost') {
    warnings.push('localhost can resolve to ::1 on macOS while the server listens on 127.0.0.1; prefer http://127.0.0.1:<port>/mcp.');
  }
  if (url.hostname === 'host.docker.internal') {
    warnings.push('host.docker.internal only resolves inside containers; LM Studio runs on the host and should use http://127.0.0.1:<port>/mcp.');
  }

  let timeout = DEFAULT_TIMEOUT_MS;
  if (v.timeout !== undefined) {
    timeout = Number(v.timeout);
    if (!Number.isInteger(timeout) || timeout < 1) throw new UsageError(`--timeout must be a positive integer (milliseconds), got "${v.timeout}"`);
    if (timeout < 1_000) warnings.push(`--timeout is in milliseconds; ${timeout} ms is too short for browser tools (recommended ${DEFAULT_TIMEOUT_MS}).`);
  }

  if (v.token !== undefined && v['no-token']) throw new UsageError('use either --token or --no-token, not both');
  if (v.token !== undefined && !v.token.trim()) throw new UsageError('--token must not be empty');
  if (v.remove && v.print) throw new UsageError('--remove and --print cannot be combined');

  const configPath = path.resolve(v.config ?? path.join(lmStudioHome(), 'mcp.json'));

  return {
    name,
    url: rawUrl,
    token: v.token?.trim(),
    clearToken: Boolean(v['no-token']),
    timeout,
    configPath,
    remove: Boolean(v.remove),
    dryRun: Boolean(v['dry-run']),
    print: Boolean(v.print),
    warnings,
  };
}

/** LM Studio's home: LMSTUDIO_HOME, else the path LM Studio records in ~/.lmstudio-home-pointer, else ~/.lmstudio. */
function lmStudioHome() {
  if (process.env.LMSTUDIO_HOME) return process.env.LMSTUDIO_HOME;
  try {
    const pointed = readFileSync(path.join(homedir(), '.lmstudio-home-pointer'), 'utf8').trim();
    if (pointed && path.isAbsolute(pointed)) return pointed;
  } catch {
    // no pointer file: default location
  }
  return path.join(homedir(), '.lmstudio');
}

function readConfig(file) {
  if (!existsSync(file)) return { exists: false, raw: null, data: { mcpServers: {} } };
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return { exists: true, raw, data: { mcpServers: {} } };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix it in LM Studio (Program > Install > Edit mcp.json) or pass --config; nothing was changed.`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must contain a JSON object; nothing was changed.`);
  if (data.mcpServers === undefined) data.mcpServers = {};
  if (data.mcpServers === null || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    throw new Error(`"mcpServers" in ${file} must be an object; nothing was changed.`);
  }
  return { exists: true, raw, data };
}

function buildEntry(existing, opts) {
  // Keep fields we do not manage (for example "auth"), but drop stdio fields:
  // LM Studio treats any entry with "command" as a stdio server.
  const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  for (const key of ['command', 'args', 'cwd', 'env']) delete entry[key];
  entry.url = opts.url;
  entry.timeout = opts.timeout;
  const headers = entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers) ? { ...entry.headers } : {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization' && (opts.token || opts.clearToken)) delete headers[key];
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (Object.keys(headers).length) entry.headers = headers;
  else delete entry.headers;
  // Stable, readable key order.
  const { url, headers: h, timeout, ...rest } = entry;
  return { url, ...(h ? { headers: h } : {}), timeout, ...rest };
}

function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret/i;

/** Copy of an mcp.json object with header, env and OAuth secrets masked, for printing. */
function redactConfig(data) {
  const next = structuredClone(data);
  const servers = next?.mcpServers && typeof next.mcpServers === 'object' ? next.mcpServers : {};
  for (const entry of Object.values(servers)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.headers && typeof entry.headers === 'object') {
      for (const [key, value] of Object.entries(entry.headers)) {
        if (typeof value !== 'string' || !SECRET_HEADER.test(key)) continue;
        const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? '';
        entry.headers[key] = `${scheme}<redacted>`;
      }
    }
    if (entry.env && typeof entry.env === 'object') {
      for (const key of Object.keys(entry.env)) entry.env[key] = '<redacted>';
    }
    if (entry.auth && typeof entry.auth === 'object') {
      for (const key of Object.keys(entry.auth)) if (/secret/i.test(key)) entry.auth[key] = '<redacted>';
    }
  }
  return next;
}

/** The file that really holds the config: follow a symlink (dotfile managers) instead of replacing it. */
function writeTarget(file) {
  try {
    return lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
  } catch {
    return file;
  }
}

function main() {
  let opts;
  try {
    opts = parse();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`setup-lmstudio: ${err.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    throw err;
  }
  for (const w of opts.warnings) process.stderr.write(`warning: ${w}\n`);

  if (opts.print) {
    const entry = buildEntry(null, opts);
    const config = Buffer.from(JSON.stringify(entry)).toString('base64');
    const query = `name=${encodeURIComponent(opts.name)}&config=${encodeURIComponent(config)}`;
    process.stdout.write(
      `mcp.json entry (LM Studio > Program > Install > Edit mcp.json):\n\n${serialize({ mcpServers: { [opts.name]: entry } })}\n` +
        `Add to LM Studio deeplink (open it in a browser or with \`open\` on macOS):\n\nlmstudio://add_mcp?${query}\n\n` +
        `Web install page:\n\nhttps://lmstudio.ai/install-mcp?${query}\n`,
    );
    if (opts.token) process.stderr.write('note: the deeplink contains your token in base64; do not share it.\n');
    return;
  }

  let current;
  try {
    current = readConfig(opts.configPath);
  } catch (err) {
    fail(err.message);
  }
  const next = structuredClone(current.data);
  const had = Object.prototype.hasOwnProperty.call(next.mcpServers, opts.name);

  if (opts.remove) {
    if (!had) {
      process.stdout.write(`"${opts.name}" is not configured in ${opts.configPath}; nothing to do.\n`);
      return;
    }
    delete next.mcpServers[opts.name];
  } else {
    next.mcpServers[opts.name] = buildEntry(had ? next.mcpServers[opts.name] : null, opts);
  }

  const output = serialize(next);
  if (current.exists && current.raw !== null && JSON.stringify(current.data) === JSON.stringify(next) && current.raw === output) {
    process.stdout.write(`${opts.configPath} already has "${opts.name}" configured this way; nothing changed.\n`);
    return;
  }

  const action = opts.remove ? `remove "${opts.name}" from` : `${had ? 'update' : 'add'} "${opts.name}" in`;
  if (opts.dryRun) {
    process.stdout.write(
      `Dry run: would ${action} ${opts.configPath}${current.exists ? '' : ' (new file)'} (secrets shown as <redacted>):\n\n${serialize(redactConfig(next))}`,
    );
    return;
  }

  const target = writeTarget(opts.configPath);
  mkdirSync(path.dirname(target), { recursive: true });
  let backup = null;
  if (current.exists) {
    backup = `${target}.bak-${timestamp()}`;
    for (let i = 1; existsSync(backup); i++) backup = `${target}.bak-${timestamp()}-${i}`;
    copyFileSync(target, backup);
  }
  // Keep the file's permissions, but never leave a bearer token readable by other users.
  let mode = current.exists ? statSync(target).mode & 0o777 : 0o644;
  const holdsToken = !opts.remove && Object.keys(next.mcpServers[opts.name]?.headers ?? {}).some((k) => k.toLowerCase() === 'authorization');
  if (holdsToken && mode & 0o077) {
    mode = (mode & 0o700) | 0o600;
    process.stdout.write(`note: ${target} now holds a token, so it is made readable by you only (mode ${mode.toString(8)}).\n`);
  }
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, output, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);

  const verb = opts.remove ? 'Removed' : had ? 'Updated' : 'Added';
  process.stdout.write(
    `${verb} "${opts.name}" ${opts.remove ? 'from' : 'in'} ${opts.configPath}${target !== opts.configPath ? ` (symlink to ${target})` : ''}${backup ? ` (backup: ${path.basename(backup)})` : ''}.\n`,
  );
  if (!opts.remove) {
    process.stdout.write(
      `\nLM Studio reloads mcp.json automatically. In a chat, open the Integrations panel and enable mcp/${opts.name}.\n` +
        `Make sure the server is running: curl ${opts.url.replace(/\/mcp\/?$/, '')}/healthz\n`,
    );
  }
}

main();
