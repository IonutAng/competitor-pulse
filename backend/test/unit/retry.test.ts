import { describe, expect, it } from 'vitest';
import { backoffMs, decideRetry } from '../../src/domain/retry.js';

const policy = { baseDelayMs: 2000, maxDelayMs: 60_000 };

describe('retry policy', () => {
  it('backs off exponentially and caps', () => {
    expect([1, 2, 3, 4].map((attempt) => backoffMs(attempt, policy))).toEqual([2000, 4000, 8000, 16_000]);
    expect(backoffMs(10, policy)).toBe(60_000);
    expect(backoffMs(1, { baseDelayMs: 100, maxDelayMs: 150 })).toBe(100);
    expect(backoffMs(2, { baseDelayMs: 100, maxDelayMs: 150 })).toBe(150);
  });

  it('retries transient failures until the attempt budget is spent', () => {
    expect(decideRetry(1, 3, true, policy)).toEqual({ outcome: 'retry', delayMs: 2000 });
    expect(decideRetry(2, 3, true, policy)).toEqual({ outcome: 'retry', delayMs: 4000 });
    expect(decideRetry(3, 3, true, policy)).toMatchObject({ outcome: 'give_up', reason: /max attempts/ });
  });

  it('never retries a failure that is not transient', () => {
    expect(decideRetry(1, 3, false, policy)).toMatchObject({ outcome: 'give_up', reason: 'not retryable' });
  });
});
