import http from 'node:http';
import net from 'node:net';
import { Browser } from './browser/browser.ts';
import { ConfigError, loadConfig } from './config.ts';
import { Hub } from './dashboard/hub.ts';
import { createLogging } from './logger.ts';
import { MCP_PATH } from './mcp/constants.ts';
import { createHttpApp } from './mcp/http.ts';
import { SessionRegistry } from './mcp/sessions.ts';
import { ObscuraProcess } from './obscura/process.ts';
import { enabledTools } from './tools/index.ts';
import { SERVER_NAME, SERVER_VERSION } from './version.ts';

async function main(): Promise<void> {
  const startedAt = new Date();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const { logger, tap, logFile, flush } = await createLogging(config);
  const log = logger.child({ component: 'main' });
  const tools = enabledTools(config);

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
      authRequired: Boolean(config.authToken),
      logLevel: config.log.level,
      logFileLevel: config.log.fileLevel,
      logFile,
    },
    `${SERVER_NAME} ${SERVER_VERSION} starting`,
  );

  // In managed mode, when the CDP port was not pinned explicitly, bind Obscura to a random free
  // ephemeral port rather than a predictable default that any local process could reach.
  if (!config.obscura.cdpUrl && !config.obscura.cdpPortExplicit) {
    try {
      config.obscura.cdpPort = await freePort();
      log.info({ cdpPort: config.obscura.cdpPort }, 'chose a random free port for the Obscura CDP endpoint');
    } catch (err) {
      log.warn({ err: (err as Error).message, cdpPort: config.obscura.cdpPort }, 'could not pick a free CDP port; using the default');
    }
  }

  const hub = new Hub(tap);
  const obscura = new ObscuraProcess(config, logger);
  const browser = new Browser(config, logger, obscura, hub);
  const sessions = new SessionRegistry(logger, hub);
  sessions.startReaper(config.sessionIdleTimeoutMs);

  // A fatal Node exit (uncaught exception, failed startup) must never leave an orphaned browser.
  process.on('exit', () => obscura.killSync());

  try {
    await obscura.start();
  } catch (err) {
    log.fatal({ err: (err as Error).message }, 'Obscura failed to start; exiting');
    await obscura.stop().catch(() => undefined);
    await flush();
    process.exit(1);
  }

  try {
    await browser.start();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'initial CDP connection failed; will retry on first tool call');
  }

  const app = createHttpApp({ config, log: logger, hub, browser, sessions, obscura, logFile, startedAt });
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
    await obscura.stop().catch(() => undefined);
    await flush();
    process.exit(1);
  }
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const base = config.publicUrl.replace(/\/$/, '');
  log.info({ mcpUrl: `${base}${MCP_PATH}`, dashboardUrl: config.dashboardEnabled ? `${base}/` : null, tools: tools.map((t) => t.name) }, `ready — MCP endpoint ${base}${MCP_PATH}${config.dashboardEnabled ? `, live dashboard ${base}/` : ''}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, 'forced exit');
      obscura.killSync();
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      obscura.killSync();
      process.exit(1);
    }, 10_000);
    force.unref();
    // Stop accepting new work and new connections; queued/late tool calls are rejected cleanly so
    // they don't reconnect to a browser that is going away.
    browser.beginShutdown();
    server.close();
    // Let in-flight tool calls flush their responses before we tear the browser down (capped).
    const settleDeadline = Date.now() + 2_000;
    while (browser.mutex.busy && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await sessions.closeAll();
    server.closeAllConnections?.();
    await browser.shutdown();
    await obscura.stop();
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
