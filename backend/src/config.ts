import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const bool = z
  .string()
  .default('true')
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

// Works from both src/ (tsx) and dist/ (compiled): the backend package root is one level up.
const packageRoot = new URL('../', import.meta.url);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  PG_POOL_MAX: positiveInt(10),

  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(1000),
  POLL_BATCH_SIZE: positiveInt(10),
  POLL_CONCURRENCY: positiveInt(5),
  SOURCE_TIMEOUT_MS: positiveInt(10_000),
  WORKERS_ENABLED: bool,

  SUMMARY_TICK_MS: z.coerce.number().int().min(100).default(1000),
  SUMMARY_CONCURRENCY: positiveInt(3),
  LLM_BASE_URL: z.url().default('http://localhost:4001/v1'),
  LLM_API_KEY: z.string().default('mock'),
  LLM_MODEL: z.string().default('mock-llm'),
  LLM_TIMEOUT_MS: positiveInt(15_000),
  LLM_MAX_ATTEMPTS: positiveInt(3),

  FIXTURES_PATH: z.string().default(fileURLToPath(new URL('fixtures/listings.json', packageRoot))),
  STATIC_DIR: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
