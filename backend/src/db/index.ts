import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

// backend/drizzle, reachable from both src/db and dist/db.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface DbOptions {
  connectionString: string;
  max: number;
  /** Receives errors from idle pooled clients (server restart, failover, proxy idle kill). */
  onError: (err: Error) => void;
}

export function createDb({ connectionString, max, onError }: DbOptions) {
  const pool = new pg.Pool({
    connectionString,
    max,
    // Fail fast when every connection is busy instead of queueing forever (which would also hang /health).
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Sent to the server per connection: no single query may pin a connection indefinitely.
    statement_timeout: 30_000,
  });
  // Without a listener the EventEmitter would throw on an idle-client error and take the whole
  // process down; with one, the pool just evicts that client.
  pool.on('error', onError);
  const db = drizzle({ client: pool, schema });
  return { pool, db };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle['db'];

export async function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  await migrate(db, { migrationsFolder });
}
