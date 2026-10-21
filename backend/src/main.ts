import pino, { type LoggerOptions } from 'pino';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { buildDeps } from './deps.js';
import { startWorkers } from './workers/index.js';

function loggerOptions(config: Config): LoggerOptions {
  if (config.NODE_ENV === 'development') {
    return {
      level: config.LOG_LEVEL,
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
    };
  }
  return { level: config.LOG_LEVEL };
}

const config = loadConfig();
const log = pino(loggerOptions(config));

// Last-resort handlers: log a structured line instead of a bare stack, then let the
// orchestrator restart the process.
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

const dbHandle = createDb({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  onError: (err) => log.error({ err }, 'idle postgres client error'),
});
const deps = buildDeps(config, dbHandle);
const app = buildApp(deps, { loggerInstance: log });

try {
  await runMigrations(dbHandle.db);
  app.log.info('database migrations applied');
  await app.listen({ port: config.PORT, host: config.HOST });
  if (config.WORKERS_ENABLED) {
    await startWorkers(deps, app.log);
    app.log.info({ pollIntervalMs: config.POLL_INTERVAL_MS }, 'background workers started');
  } else {
    app.log.info('background workers disabled (WORKERS_ENABLED=false)');
  }
} catch (err) {
  app.log.fatal({ err }, 'startup failed');
  await dbHandle.pool.end();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, budgetMs: config.SHUTDOWN_TIMEOUT_MS }, 'shutting down');
  const deadline = setTimeout(() => {
    app.log.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS).unref();
  try {
    // Stop taking traffic first (health probes start failing), then stop the loops — which
    // aborts any LLM or source call in flight — and only then release the database.
    await app.close();
    await Promise.all(deps.runtime.loops.map((loop) => loop.stop()));
    await dbHandle.pool.end();
    clearTimeout(deadline);
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
