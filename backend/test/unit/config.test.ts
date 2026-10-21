import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = { DATABASE_URL: 'postgres://app:app@localhost:5439/competitorpulse' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      PORT: 3000,
      POLL_INTERVAL_MS: 10_000,
      WORKERS_ENABLED: true,
      LLM_MODEL: 'mock-llm',
      LLM_MAX_ATTEMPTS: 3,
    });
    expect(config.FIXTURES_PATH).toMatch(/fixtures\/listings\.json$/);
  });

  it('derives the shutdown budget from the LLM timeout unless set explicitly', () => {
    expect(loadConfig(base).SHUTDOWN_TIMEOUT_MS).toBe(20_000);
    expect(loadConfig({ ...base, LLM_TIMEOUT_MS: '2000' }).SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(loadConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '1234' }).SHUTDOWN_TIMEOUT_MS).toBe(1234);
  });

  it('parses booleans strictly', () => {
    expect(loadConfig({ ...base, WORKERS_ENABLED: 'false' }).WORKERS_ENABLED).toBe(false);
    expect(loadConfig({ ...base, WORKERS_ENABLED: '0' }).WORKERS_ENABLED).toBe(false);
    expect(loadConfig({ ...base, WORKERS_ENABLED: 'yes' }).WORKERS_ENABLED).toBe(true);
    expect(() => loadConfig({ ...base, WORKERS_ENABLED: 'flase' })).toThrow(/WORKERS_ENABLED/);
  });

  it('refuses a connection pool the workers could exhaust', () => {
    expect(() =>
      loadConfig({ ...base, PG_POOL_MAX: '5', POLL_CONCURRENCY: '5', SUMMARY_CONCURRENCY: '3' }),
    ).toThrow(/PG_POOL_MAX/);
    expect(
      loadConfig({ ...base, PG_POOL_MAX: '10', POLL_CONCURRENCY: '5', SUMMARY_CONCURRENCY: '3' }).PG_POOL_MAX,
    ).toBe(10);
  });

  it('rejects nonsense with the offending variable named', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, LLM_BASE_URL: 'not a url' })).toThrow(/LLM_BASE_URL/);
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '10' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() =>
      loadConfig({ ...base, SUMMARY_BACKOFF_BASE_MS: '5000', SUMMARY_BACKOFF_MAX_MS: '1000' }),
    ).toThrow(/SUMMARY_BACKOFF_MAX_MS/);
  });
});
