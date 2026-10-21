import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/index.js';

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
const app = buildApp({ config, db }, { logger: loggerOptions(config) });

try {
  await runMigrations(db);
  app.log.info('database migrations applied');
  await app.listen({ port: config.PORT, host: config.HOST });
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
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
