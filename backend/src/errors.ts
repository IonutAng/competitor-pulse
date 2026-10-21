/** A message for logs and error columns, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * The Postgres SQLSTATE of an error, looking through wrappers (Drizzle wraps driver errors and
 * exposes the original as `cause`).
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}
