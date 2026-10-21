export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Delay before retrying after the given (1-based) failed attempt: base, 2×base, 4×base, ... capped. */
export function backoffMs(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export type RetryDecision = { outcome: 'retry'; delayMs: number } | { outcome: 'give_up'; reason: string };

/**
 * Pure retry policy. Whether a failure is transient is decided by whoever understands the
 * failure (see `isTransientSummarizerError` in llm/summarizer.ts); this only applies the budget.
 */
export function decideRetry(
  attempt: number,
  maxAttempts: number,
  transient: boolean,
  policy: BackoffPolicy,
): RetryDecision {
  if (!transient) return { outcome: 'give_up', reason: 'not retryable' };
  if (attempt >= maxAttempts) return { outcome: 'give_up', reason: `max attempts (${maxAttempts}) reached` };
  return { outcome: 'retry', delayMs: backoffMs(attempt, policy) };
}
