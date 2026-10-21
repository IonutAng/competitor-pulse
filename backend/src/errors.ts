import pg from 'pg';

/** A message for logs and error columns, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The SQLSTATE of a Postgres error, looking through wrappers (Drizzle wraps driver errors and
 * exposes the original as `cause`).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof pg.DatabaseError) return current.code;
    current = current.cause;
  }
  return undefined;
}
