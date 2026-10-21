import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { CompetitorRepo } from './repo/competitors.js';

/** Everything the HTTP routes and the background workers share. Built once in main.ts and in tests. */
export interface Deps {
  config: Config;
  db: Db;
  competitors: CompetitorRepo;
}

export function buildDeps(config: Config, db: Db): Deps {
  return {
    config,
    db,
    competitors: new CompetitorRepo(db),
  };
}
