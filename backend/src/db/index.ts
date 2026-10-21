import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

// backend/drizzle, reachable from both src/db and dist/db.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function createDb(connectionString: string, max: number) {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createDb>['db'];

export async function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  await migrate(db, { migrationsFolder });
}
