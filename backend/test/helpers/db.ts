import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from '../../src/db/index.js';

// Created by docker/db-init.sql when the compose Postgres volume is first initialised.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5439/competitorpulse_test';

export async function setupTestDb() {
  const { pool, db } = createDb(TEST_DATABASE_URL, 5);
  await runMigrations(db);
  return {
    db,
    pool,
    /** Empties both tables; call it before each test. */
    async reset() {
      await db.execute(sql`TRUNCATE TABLE snapshots, competitors RESTART IDENTITY CASCADE`);
    },
    async close() {
      await pool.end();
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof setupTestDb>>;
