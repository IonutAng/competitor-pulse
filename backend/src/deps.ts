import type { Config } from './config.js';
import type { DbHandle } from './db/index.js';
import { OpenAiCompatibleSummarizer, type Summarizer } from './llm/summarizer.js';
import { CompetitorRepo } from './repo/competitors.js';
import { SnapshotRepo } from './repo/snapshots.js';
import { FixtureListingSource } from './source/fixture-source.js';
import type { ListingSource } from './source/listing-source.js';
import type { Loop } from './workers/loop.js';

/** Everything the HTTP routes and the background workers share. Built once in main.ts and in tests. */
export interface Deps {
  config: Config;
  db: DbHandle['db'];
  pool: DbHandle['pool'];
  competitors: CompetitorRepo;
  snapshots: SnapshotRepo;
  source: ListingSource;
  summarizer: Summarizer;
  /** Filled in once the workers start; /health reports from it. */
  runtime: { loops: Loop[] };
}

export type DepsOverrides = Partial<Pick<Deps, 'source' | 'summarizer'>>;

export function buildDeps(config: Config, { db, pool }: DbHandle, overrides: DepsOverrides = {}): Deps {
  return {
    config,
    db,
    pool,
    competitors: new CompetitorRepo(db),
    snapshots: new SnapshotRepo(db),
    source: overrides.source ?? FixtureListingSource.fromFile(config.FIXTURES_PATH),
    summarizer:
      overrides.summarizer ??
      new OpenAiCompatibleSummarizer({
        baseURL: config.LLM_BASE_URL,
        apiKey: config.LLM_API_KEY,
        model: config.LLM_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
        maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
      }),
    runtime: { loops: [] },
  };
}
