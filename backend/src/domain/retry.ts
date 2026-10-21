export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseDelayMs: 2000, maxDelayMs: 60_000 };

/** Delay before retrying after the given (1-based) failed attempt: 2 s, 4 s, 8 s, ... capped. */
export function backoffMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Timeouts, connection errors, 5xx and 429 are transient. Any other 4xx (bad request, bad key,
 * unknown model) will fail the same way next time, so retrying only spends money.
 */
export function isRetryable(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

export type RetryDecision = { outcome: 'retry'; delayMs: number } | { outcome: 'give_up'; reason: string };

export function decideRetry(
  attempt: number,
  maxAttempts: number,
  err: unknown,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): RetryDecision {
  if (!isRetryable(err)) return { outcome: 'give_up', reason: 'not retryable' };
  if (attempt >= maxAttempts) return { outcome: 'give_up', reason: `max attempts (${maxAttempts}) reached` };
  return { outcome: 'retry', delayMs: backoffMs(attempt, policy) };
}
