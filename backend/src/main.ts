import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { buildDeps } from './deps.js';
import { startWorkers } from './workers/index.js';
import type { Loop } from './workers/loop.js';

function loggerOptions(config: Config) {
  if (config.NODE_ENV === 'development') {
    return {
      level: config.LOG_LEVEL,
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
    };
  }
  return { level: config.LOG_LEVEL };
}

const config = loadConfig();
const { pool, db } = createDb(config.DATABASE_URL, config.PG_POOL_MAX);
const deps = buildDeps(config, db);
const app = buildApp(deps, { logger: loggerOptions(config) });

let workers: Loop[] = [];
try {
  await runMigrations(db);
  app.log.info('database migrations applied');
  await app.listen({ port: config.PORT, host: config.HOST });
  if (config.WORKERS_ENABLED) {
    workers = await startWorkers(deps, app.log);
    app.log.info({ pollIntervalMs: config.POLL_INTERVAL_MS }, 'background workers started');
  } else {
    app.log.info('background workers disabled (WORKERS_ENABLED=false)');
  }
} catch (err) {
  app.log.fatal({ err }, 'startup failed');
  await pool.end();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // Hard stop if something hangs (an in-flight request or a pool that will not drain).
  setTimeout(() => process.exit(1), 10_000).unref();
  await Promise.all(workers.map((worker) => worker.stop()));
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
