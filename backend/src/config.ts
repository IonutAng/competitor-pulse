import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

// Works from both src/ (tsx) and dist/ (compiled): the backend package root is one level up.
const packageRoot = new URL('../', import.meta.url);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    PG_POOL_MAX: positiveInt(10),

    POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
    SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(1000),
    POLL_BATCH_SIZE: positiveInt(10),
    POLL_CONCURRENCY: positiveInt(5),
    SOURCE_TIMEOUT_MS: positiveInt(10_000),
    // Listing text comes from the outside world; cap what one field may store.
    MAX_LISTING_FIELD_CHARS: positiveInt(10_000),
    WORKERS_ENABLED: z.stringbool().default(true),

    SUMMARY_TICK_MS: z.coerce.number().int().min(100).default(1000),
    SUMMARY_CONCURRENCY: positiveInt(3),
    // Backoff between LLM attempts: base × 2^(attempt−1), capped. Demo-friendly defaults; a
    // production deployment would use something like 10000 / 600000 with LLM_MAX_ATTEMPTS=5.
    SUMMARY_BACKOFF_BASE_MS: positiveInt(2000),
    SUMMARY_BACKOFF_MAX_MS: positiveInt(60_000),
    LLM_BASE_URL: z.url().default('http://localhost:4001/v1'),
    LLM_API_KEY: z.string().default('mock'),
    LLM_MODEL: z.string().default('mock-llm'),
    LLM_TIMEOUT_MS: positiveInt(15_000),
    LLM_MAX_ATTEMPTS: positiveInt(3),
    LLM_MAX_OUTPUT_TOKENS: positiveInt(200),

    // How long a SIGTERM may take before the process force-exits. Defaults to cover one LLM call.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

    FIXTURES_PATH: z.string().default(fileURLToPath(new URL('fixtures/listings.json', packageRoot))),
    STATIC_DIR: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const needed = c.POLL_CONCURRENCY + c.SUMMARY_CONCURRENCY + 2;
    if (c.PG_POOL_MAX < needed) {
      ctx.addIssue({
        code: 'custom',
        path: ['PG_POOL_MAX'],
        message: `must be at least POLL_CONCURRENCY + SUMMARY_CONCURRENCY + 2 (${needed}) so the workers cannot starve API requests of connections`,
      });
    }
    if (c.SUMMARY_BACKOFF_MAX_MS < c.SUMMARY_BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUMMARY_BACKOFF_MAX_MS'],
        message: 'must be >= SUMMARY_BACKOFF_BASE_MS',
      });
    }
  })
  .transform((c) => ({
    ...c,
    SHUTDOWN_TIMEOUT_MS: c.SHUTDOWN_TIMEOUT_MS ?? Math.max(10_000, c.LLM_TIMEOUT_MS + 5_000),
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
