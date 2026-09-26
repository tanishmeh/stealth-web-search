import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { safeEndpoint } from './agents/llm.ts';
import { AgentManager } from './agents/manager.ts';
import { Browser } from './browser/browser.ts';
import { BrowserRegistry } from './browser/registry.ts';
import { ConfigError, DEFAULT_MODELS_FILE, loadConfig } from './config.ts';
import { Hub } from './dashboard/hub.ts';
import { createLogging } from './logger.ts';
import { MCP_PATH } from './mcp/constants.ts';
import { createHttpApp } from './mcp/http.ts';
import type { McpDeps } from './mcp/server.ts';
import { SessionRegistry } from './mcp/sessions.ts';
import { ObscuraProcess } from './obscura/process.ts';
import { ScriptService } from './scripts/service.ts';
import { enabledTools } from './tools/index.ts';
import { SERVER_NAME, SERVER_VERSION } from './version.ts';

async function main(): Promise<void> {
  const startedAt = new Date();
  let config;
  let tools;
  try {
    config = loadConfig(process.env, { defaultModelsFile: DEFAULT_MODELS_FILE });
    tools = enabledTools(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const { logger, tap, logFile, flush } = await createLogging(config);
  const log = logger.child({ component: 'main' });

  log.info(
    {
      version: SERVER_VERSION,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      host: config.host,
      port: config.port,
      stealth: config.obscura.stealth,
      proxy: config.obscura.proxy ? 'configured' : null,
      allowPrivateNetwork: config.obscura.allowPrivateNetwork,
      viewport: config.browser.viewport,
      toolsets: config.browser.toolsets,
      toolCount: tools.length,
      agents: config.agent.enabled
        ? {
            config: config.agent.source.type === 'file' ? config.agent.source.file : 'AGENT_LLM_* environment variables',
            provider: config.agent.source.type === 'file' ? config.agent.source.provider : undefined,
            endpoint: safeEndpoint(config.agent.endpoint),
            model: config.agent.model ?? '(first listed)',
            apiKey: config.agent.apiKey ? 'configured' : null,
            contextTokens: config.agent.contextTokens,
            maxOutputTokens: config.agent.maxOutputTokens,
            reasoningEffort: config.agent.reasoningEffort,
            maxConcurrent: config.agent.maxConcurrent,
          }
        : `disabled (${config.agent.disabledReason})`,
      scriptsDir: config.scripts.dir,
      authRequired: Boolean(config.authToken),
      logLevel: config.log.level,
      logFileLevel: config.log.fileLevel,
      logFile,
    },
    `${SERVER_NAME} ${SERVER_VERSION} starting`,
  );
  const agentSource = config.agent.source;
  for (const warning of agentSource.warnings) log.warn(warning);
  if (agentSource.type === 'file' && agentSource.overrides.length) {
    log.info({ overrides: agentSource.overrides }, `agent model from ${agentSource.file}; ${agentSource.overrides.join(', ')} from the environment take precedence`);
  }

  // In managed mode, when the CDP port was not pinned explicitly, bind Obscura to a random free
  // ephemeral port rather than a predictable default that any local process could reach.
  if (!config.obscura.cdpUrl && !config.obscura.cdpPortExplicit) {
    try {
      // the HTTP port is still free at this point: never hand it to the engine
      let cdpPort = await freePort();
      for (let i = 0; i < 5 && cdpPort === config.port; i++) cdpPort = await freePort();
      if (cdpPort === config.port) throw new Error('only the HTTP port was offered');
      config.obscura.cdpPort = cdpPort;
      log.info({ cdpPort: config.obscura.cdpPort }, 'chose a random free port for the Obscura CDP endpoint');
    } catch (err) {
      log.warn({ err: (err as Error).message, cdpPort: config.obscura.cdpPort }, 'could not pick a free CDP port; using the default');
    }
  }

  const hub = new Hub(tap);
  const obscura = new ObscuraProcess(config, logger);
  // one 'exit' listener per open browser: the main one plus sub-agent and script browsers
  obscura.setMaxListeners(200);
  // Sub-agent and script browsers get a second engine: a page that crashes the engine there (Obscura
  // v0.2.2 has such bugs) then never resets the main browser. With OBSCURA_STORAGE_DIR it is required:
  // the engine persists one cookie jar for all its connections, and the second one has no storage, so
  // sub-agents never load or write the host's persisted logins.
  let isolatedEngine: ObscuraProcess | null = null;
  if ((config.obscura.separateEngine || config.obscura.storageDir) && !config.obscura.cdpUrl) {
    let cdpPort = config.obscura.cdpPort + 1;
    try {
      // a port just released by the main engine's probe may be handed out again: never take its port or ours
      for (let i = 0; i < 5; i++) {
        cdpPort = await freePort();
        if (cdpPort !== config.obscura.cdpPort && cdpPort !== config.port) break;
      }
    } catch {
      // keep the neighbouring port
    }
    isolatedEngine = new ObscuraProcess({ ...config, obscura: { ...config.obscura, storageDir: undefined, cdpPort } }, logger.child({ engine: 'isolated' }));
    isolatedEngine.setMaxListeners(200);
    log.info(
      { cdpPort },
      config.obscura.storageDir
        ? 'sub-agent and script browsers use a separate engine without persisted cookies'
        : 'sub-agent and script browsers use a separate engine',
    );
  }
  const isolatedObscura = isolatedEngine ?? obscura;
  const browser = new Browser(config, logger, obscura, hub);
  const sessions = new SessionRegistry(logger, hub);
  sessions.startReaper(config.sessionIdleTimeoutMs);
  const registry = new BrowserRegistry(browser, hub);
  const deps: McpDeps = { config, log: logger, hub, browser, sessions, agents: null, scripts: null };
  const scripts = new ScriptService(deps, isolatedObscura, registry);
  deps.scripts = scripts;
  const agents = config.agent.enabled ? new AgentManager(deps, isolatedObscura, registry) : null;
  deps.agents = agents;

  // A fatal Node exit (uncaught exception, failed startup) must never leave an orphaned browser.
  process.on('exit', () => {
    obscura.killSync();
    isolatedEngine?.killSync();
  });

  if (config.obscura.storageDir && !config.obscura.cdpUrl) {
    // Obscura writes the cookie jar only at shutdown: find out now whether it will be able to
    const dir = config.obscura.storageDir;
    try {
      mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
    } catch (err) {
      log.error(
        { dir, uid: process.getuid?.(), err: (err as Error).message },
        `OBSCURA_STORAGE_DIR ${dir} is not writable: cookies will NOT persist. Make the folder writable by the server's user (Docker on Linux: sudo chown -R 1000:1000 on the host folder)`,
      );
    }
  }

  try {
    await obscura.start();
    await isolatedEngine?.start();
  } catch (err) {
    log.fatal({ err: (err as Error).message }, 'Obscura failed to start; exiting');
    await obscura.stop().catch(() => undefined);
    await isolatedEngine?.stop().catch(() => undefined);
    await flush();
    process.exit(1);
  }

  try {
    await browser.start();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'initial CDP connection failed; will retry on first tool call');
  }

  const app = createHttpApp({ ...deps, obscura, isolatedObscura: isolatedEngine, registry, logFile, startedAt });
  // http.createServer(app) rather than app.listen(...): Express passes a listen callback as the
  // 'error' handler too, so a failed bind (e.g. EADDRINUSE) would resolve as if it had succeeded.
  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  } catch (err) {
    log.fatal({ err: (err as Error).message, host: config.host, port: config.port }, 'HTTP server failed to start; exiting');
    obscura.killSync();
    isolatedEngine?.killSync();
    await obscura.stop().catch(() => undefined);
    await isolatedEngine?.stop().catch(() => undefined);
    await flush();
    process.exit(1);
  }
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const base = config.publicUrl.replace(/\/$/, '');
  log.info({ mcpUrl: `${base}${MCP_PATH}`, dashboardUrl: config.dashboardEnabled ? `${base}/` : null, tools: tools.map((t) => t.name) }, `ready — MCP endpoint ${base}${MCP_PATH}${config.dashboardEnabled ? `, live dashboard ${base}/` : ''}`);

  if (agents) {
    // Check the model endpoint once at startup so a wrong URL, key or model id shows up in the logs right away.
    const endpoint = safeEndpoint(config.agent.endpoint);
    agents.llm.listModels(10_000).then(
      (ids) => {
        const wanted = config.agent.model;
        if (wanted && ids.length && !ids.includes(wanted)) {
          log.warn({ endpoint, model: wanted, available: ids }, `agent model "${wanted}" is not listed by the endpoint; agent runs may fail`);
        } else {
          log.info({ endpoint, models: ids, model: wanted ?? ids[0] ?? null }, 'agent model endpoint reachable');
        }
      },
      (err) => log.warn({ endpoint, err: (err as Error).message }, 'agent model endpoint not reachable (yet); agent runs fail until it is'),
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, 'forced exit');
      obscura.killSync();
    isolatedEngine?.killSync();
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      obscura.killSync();
    isolatedEngine?.killSync();
      process.exit(1);
    }, 10_000);
    force.unref();
    // Stop accepting new work and new connections; queued/late tool calls are rejected cleanly so
    // they don't reconnect to a browser that is going away.
    browser.beginShutdown();
    agents?.beginShutdown();
    scripts.beginShutdown();
    server.close();
    // sub-agent and script runs are cancelled; give them a moment to close their browsers and write transcripts
    await Promise.all([agents?.shutdown(4_000).catch(() => undefined), scripts.shutdown(4_000).catch(() => undefined)]);
    // Let in-flight tool calls flush their responses before we tear the browser down (capped).
    const settleDeadline = Date.now() + 2_000;
    while (browser.mutex.busy && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await sessions.closeAll();
    server.closeAllConnections?.();
    await browser.shutdown();
    await Promise.all([obscura.stop(), isolatedEngine?.stop()]);
    log.info('shutdown complete');
    await flush();
    process.exit(0);
  };
  if (process.env.SBM_EXIT_WITH_PARENT === '1') {
    // used by the test harness: never outlive the process that started us
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) void shutdown('parent process exited');
    }, 1_000).unref();
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception; exiting');
    obscura.killSync();
    isolatedEngine?.killSync();
    void flush().finally(() => process.exit(1));
  });
}

/** An OS-assigned free TCP port on loopback (used for the managed Obscura CDP endpoint). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not determine a free port'))));
    });
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
