import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { CompetitorRepo } from './repo/competitors.js';
import { SnapshotRepo } from './repo/snapshots.js';
import { FixtureListingSource } from './source/fixture-source.js';
import type { ListingSource } from './source/listing-source.js';

/** Everything the HTTP routes and the background workers share. Built once in main.ts and in tests. */
export interface Deps {
  config: Config;
  db: Db;
  competitors: CompetitorRepo;
  snapshots: SnapshotRepo;
  source: ListingSource;
}

export function buildDeps(config: Config, db: Db, overrides: Partial<Pick<Deps, 'source'>> = {}): Deps {
  return {
    config,
    db,
    competitors: new CompetitorRepo(db),
    snapshots: new SnapshotRepo(db),
    source: overrides.source ?? FixtureListingSource.fromFile(config.FIXTURES_PATH),
  };
}
