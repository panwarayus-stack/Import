'use strict';

/**
 * HTTP server entrypoint.
 *
 * Set WORKER_ENABLED=false to run a dashboard-only web process (recommended pattern:
 * one long-lived worker process + one web process, both sharing the SQLite file), or
 * keep the default to run everything in a single process (simplest for a VPS).
 */

const http = require('node:http');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');

function checkRuntime() {
  // node:sqlite shipped in Node 22.5; without it the app needs the native better-sqlite3
  // module. Fail with a human explanation instead of a stack trace deep in the worker.
  const { driverInfo } = require('./lib/sqlite');
  const drivers = driverInfo();
  if (!drivers.betterSqlite3 && !drivers.nodeSqlite) {
    console.error(
      `SQLite unavailable: this process is Node ${process.version}, which has no built-in node:sqlite ` +
        '(< 22.5) and the optional better-sqlite3 module could not be loaded. ' +
        'Run Node 22.5+ (see .node-version / engines) or `npm rebuild better-sqlite3`.',
    );
    process.exit(1);
  }
  return drivers;
}

async function main() {
  const drivers = checkRuntime();
  const ctx = bootstrap();
  if (drivers.nodeSqlite && !drivers.betterSqlite3) {
    ctx.logger.info("SQLite driver: Node's built-in node:sqlite (better-sqlite3 not installed)");
  }
  const { config, db, logger, worker, scheduler, oauth, comments, openrouter } = ctx;

  const app = createApp({ config, db, logger, worker, scheduler, oauth, comments, openrouter });
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  logger.info(`Dashboard listening on http://${config.host}:${config.port}`);
  if (config.isProduction && !config.dashboard.password) {
    logger.error('DASHBOARD_PASSWORD is not set. The dashboard will reject every login until it is configured.');
  }
  for (const warning of config.warnings) logger.warn(warning);

  if (config.worker.enabled) {
    await worker.start({ runScheduler: config.worker.schedulerEnabled });
    logger.info('Background worker started in this process');
  } else {
    logger.info('WORKER_ENABLED=false — this process only serves the dashboard');
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; shutting down gracefully`);
    const timeout = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
    timeout.unref();

    server.close();
    try {
      await worker.stop({ timeoutMs: 20000 });
      scheduler.stop();
    } catch (error) {
      logger.error(`Worker shutdown error: ${error.message}`);
    }
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    shutdown('uncaughtException');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal startup error: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
