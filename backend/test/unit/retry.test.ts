import { describe, expect, it } from 'vitest';
import { backoffMs, decideRetry, isRetryable } from '../../src/domain/retry.js';
import { httpError } from '../helpers/summarizer.js';

describe('retry policy', () => {
  it('backs off exponentially and caps', () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a))).toEqual([2000, 4000, 8000, 16_000]);
    expect(backoffMs(10)).toBe(60_000);
    expect(backoffMs(1, { baseDelayMs: 100, maxDelayMs: 150 })).toBe(100);
    expect(backoffMs(2, { baseDelayMs: 100, maxDelayMs: 150 })).toBe(150);
  });

  it('retries transient failures only', () => {
    expect(isRetryable(new Error('timeout'))).toBe(true); // no status: timeout / network
    expect(isRetryable(httpError(500))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });

  it('decides retry vs give up from the attempt number and the error', () => {
    expect(decideRetry(1, 3, new Error('timeout'))).toEqual({ outcome: 'retry', delayMs: 2000 });
    expect(decideRetry(2, 3, httpError(500))).toEqual({ outcome: 'retry', delayMs: 4000 });
    expect(decideRetry(3, 3, new Error('timeout'))).toMatchObject({ outcome: 'give_up', reason: /max attempts/ });
    expect(decideRetry(1, 3, httpError(401))).toMatchObject({ outcome: 'give_up', reason: 'not retryable' });
  });
});
