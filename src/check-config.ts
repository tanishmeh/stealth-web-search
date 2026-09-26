/**
 * Checks the configuration without starting the server: validates the environment variables and
 * config/models.json, prints what the server and the sub-agents will use, and with --ping asks the
 * model endpoint for its model list.
 *
 *   npm run config:check -- --ping
 *   docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping
 *
 * Exit codes: 0 fine, 1 the endpoint check failed, 2 invalid configuration.
 */
import pino from 'pino';
import { ChatClient, safeEndpoint } from './agents/llm.ts';
import { ConfigError, DEFAULT_MODELS_FILE, loadConfig } from './config.ts';
import { enabledTools } from './tools/index.ts';

const USAGE = `Usage: check-config [--ping] [--env-file <path>]

Validates the configuration (environment variables and config/models.json) and prints the
settings the server will use. --ping also checks that the sub-agents' model endpoint answers.
--env-file loads variables from a .env file first (variables already set win).`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const unknown = args.filter((a, i) => !['--ping', '--env-file'].includes(a) && args[i - 1] !== '--env-file');
  if (unknown.length) {
    process.stderr.write(`Unknown argument: ${unknown[0]}\n\n${USAGE}\n`);
    return 2;
  }
  const envFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : undefined;
  if (args.includes('--env-file') && !envFile) {
    process.stderr.write(`--env-file needs a path\n\n${USAGE}\n`);
    return 2;
  }
  if (envFile) {
    try {
      process.loadEnvFile(envFile);
    } catch (err) {
      process.stderr.write(`Cannot read ${envFile}: ${(err as Error).message}\n`);
      return 2;
    }
  }

  let config;
  let toolCount;
  try {
    config = loadConfig(process.env, { defaultModelsFile: DEFAULT_MODELS_FILE });
    toolCount = enabledTools(config).length;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const rows: Array<[string, string]> = [];
  const row = (label: string, value: string) => rows.push([label, value]);
  const print = (title: string) => {
    process.stdout.write(`\n${title}\n`);
    const width = Math.max(...rows.map(([l]) => l.length));
    for (const [l, v] of rows) process.stdout.write(`  ${l.padEnd(width)}  ${v}\n`);
    rows.length = 0;
  };

  process.stdout.write('Configuration is valid.\n');
  row('MCP endpoint', `${config.publicUrl.replace(/\/$/, '')}/mcp`);
  row('auth', config.authToken ? 'bearer token required (AUTH_TOKEN)' : 'none');
  row('tools', `${toolCount} (TOOLSETS=${config.browser.toolsets.join(',')})`);
  row('private network', config.obscura.allowPrivateNetwork ? 'allowed' : 'blocked');
  row('stealth', config.obscura.stealth ? 'on' : 'off');
  row('log files', config.log.dir);
  print('Server');

  const a = config.agent;
  if (!a.enabled) {
    process.stdout.write(`\nSub-agents: off (${config.agent.disabledReason})\n`);
    return 0;
  }
  const src = a.source;
  if (src.type === 'file') {
    row('config', `${src.file} (provider "${src.provider}"${src.vendor ? `, vendor ${src.vendor}` : ''})`);
    if (src.overrides.length) row('overridden by', src.overrides.join(', '));
  } else {
    row('config', 'AGENT_LLM_* environment variables');
  }
  row('model', `${a.model ?? '(the first model the endpoint lists)'}${src.type === 'file' && src.name ? ` (${src.name})` : ''}`);
  row('endpoint', safeEndpoint(a.endpoint) ?? '');
  row('api key', a.apiKey ? 'set' : 'none');
  row('reasoning', a.reasoningEffort ? `${a.reasoningEffort} (sent as reasoning_effort)` : 'not sent');
  row('sampling', [a.temperature !== null ? `temperature ${a.temperature}` : null, a.topP !== null ? `top_p ${a.topP}` : null].filter(Boolean).join(', ') || 'model defaults');
  if (Object.keys(a.extraBody).length) row('extra fields', JSON.stringify(a.extraBody));
  if (a.thinking !== null) row('thinking', a.thinking ? 'on (chat_template_kwargs)' : 'off (chat_template_kwargs)');
  row('context budget', `${a.contextTokens} tokens, up to ${a.maxOutputTokens} per response (${a.maxTokensField})`);
  row('streaming', a.streaming ? 'on' : 'off');
  row('concurrency', `${a.maxConcurrent} runs at a time, ${a.maxSteps} steps each`);
  if (src.type === 'file' && src.available.length > 1) row('in the file', src.available.join(', '));
  print('Sub-agents: on');
  if (src.warnings.length) {
    process.stdout.write('\nWarnings:\n');
    for (const w of src.warnings) process.stdout.write(`  - ${w}\n`);
  }

  if (!args.includes('--ping')) {
    process.stdout.write('\nRun with --ping to check that the model endpoint answers.\n');
    return 0;
  }
  const client = new ChatClient(a, pino({ level: 'silent' }));
  process.stdout.write(`\nChecking ${safeEndpoint(a.endpoint)} ...\n`);
  try {
    const ids = await client.listModels(15_000);
    if (a.model && ids.length && !ids.includes(a.model)) {
      process.stdout.write(`The endpoint answers, but does not list "${a.model}". It lists: ${ids.join(', ')}\n`);
      return 1;
    }
    process.stdout.write(`The endpoint answers${ids.length ? ` and lists ${ids.join(', ')}` : ''}.\n`);
    return 0;
  } catch (err) {
    process.stdout.write(`The endpoint did not answer: ${(err as Error).message}\n`);
    if (/host\.docker\.internal/.test(a.endpoint ?? '')) {
      process.stdout.write('host.docker.internal only resolves inside Docker: run this check in the container (docker compose run --rm --no-deps stealth-web-search node dist/check-config.js --ping).\n');
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  },
);
