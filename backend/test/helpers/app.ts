import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/index.js';
import { buildDeps, type Deps } from '../../src/deps.js';
import { TEST_DATABASE_URL } from './db.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    WORKERS_ENABLED: 'false',
    ...overrides,
  });
}

export function testDeps(db: Db, overrides: NodeJS.ProcessEnv = {}): Deps {
  return buildDeps(testConfig(overrides), db);
}

export function buildTestApp(db: Db, overrides: NodeJS.ProcessEnv = {}) {
  return buildApp(testDeps(db, overrides), { logger: false });
}
