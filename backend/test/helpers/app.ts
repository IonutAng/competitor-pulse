import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { DbHandle } from '../../src/db/index.js';
import { buildDeps, type Deps, type DepsOverrides } from '../../src/deps.js';
import { TEST_DATABASE_URL } from './db.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    WORKERS_ENABLED: 'false',
    ...overrides,
  });
}

export function testDeps(handle: DbHandle, env: NodeJS.ProcessEnv = {}, overrides: DepsOverrides = {}): Deps {
  return buildDeps(testConfig(env), handle, overrides);
}

export function buildTestApp(deps: Deps) {
  return buildApp(deps, { logger: false });
}
