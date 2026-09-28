import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
  images: Array<{ data: string; mimeType: string }>;
  raw: any;
}

export interface TestServer {
  mcpUrl: string;
  baseUrl: string;
  logDir: string | null;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallOutcome>;
  /** Parsed JSON log lines written by the server (managed mode only). */
  logs: () => Array<Record<string, any>>;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** `clientOptions` go to the SDK Client, e.g. `{ versionNegotiation: { mode: 'auto' } }` for the stateless 2026-07-28 protocol. */
export async function connectClient(
  mcpUrl: string,
  name = 'integration-test',
  clientOptions?: Record<string, unknown>,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name, version: '1.0.0' }, clientOptions as any);
  const headers: Record<string, string> = {};
  if (process.env.AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Start the MCP server under test.
 *
 * - Default: spawn `node src/main.ts` with random ports, a temp log dir and
 *   the local Obscura binary from `npm run obscura:download`.
 * - MCP_URL set: use an already running server (e.g. the Docker container).
 *   Pair with FIXTURE_HOST=host.docker.internal so the containerized browser
 *   can reach the fixture site, and run the container with ALLOW_PRIVATE_NETWORK=true.
 */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  let child: ChildProcess | null = null;
  let logDir: string | null = null;
  let mcpUrl = process.env.MCP_URL;
  let baseUrl = mcpUrl ? mcpUrl.replace(/\/mcp\/?$/, '') : '';

  if (!mcpUrl) {
    const port = await freePort();
    let cdpPort = await freePort();
    while (cdpPort === port) cdpPort = await freePort();
    logDir = mkdtempSync(path.join(tmpdir(), 'sbm-test-logs-'));
    const output: string[] = [];
    child = spawn(process.execPath, ['src/main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        OBSCURA_CDP_PORT: String(cdpPort),
        LOG_DIR: logDir,
        LOG_FORMAT: 'json',
        LOG_LEVEL: 'warn',
        LOG_FILE_LEVEL: 'debug',
        ALLOW_PRIVATE_NETWORK: 'true',
        // stop the server if the test runner dies without cleaning up
        SBM_EXIT_WITH_PARENT: '1',
        // never the developer's own config/models.json: tests configure their model themselves
        AGENT_MODELS_FILE: 'none',
        // never the developer's saved sign-ins or key
        SNAPSHOTS_DIR: mkdtempSync(path.join(tmpdir(), 'sbm-test-snapshots-')),
        SNAPSHOTS_KEY: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => output.push(String(d)));
    child.stderr!.on('data', (d) => output.push(String(d)));
    baseUrl = `http://127.0.0.1:${port}`;
    mcpUrl = `${baseUrl}/mcp`;
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${output.join('')}`);
      try {
        const res = await fetch(`${baseUrl}/healthz`);
        if (res.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`server did not become healthy:\n${output.join('')}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const { client, transport } = await connectClient(mcpUrl);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome> => {
    const raw: any = await client.callTool({ name, arguments: args });
    const content: any[] = raw.content ?? [];
    return {
      text: content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      isError: Boolean(raw.isError),
      images: content.filter((c) => c.type === 'image').map((c) => ({ data: c.data, mimeType: c.mimeType })),
      raw,
    };
  };

  const logs = () => {
    if (!logDir) return [];
    try {
      return readFileSync(path.join(logDir, 'current.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  const stop = async () => {
    try {
      await transport.terminateSession();
    } catch {
      // ignore
    }
    await client.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  return { mcpUrl, baseUrl, logDir, client, call, logs, stop };
}
