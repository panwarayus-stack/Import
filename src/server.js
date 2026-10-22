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

async function main() {
  const ctx = bootstrap();
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
