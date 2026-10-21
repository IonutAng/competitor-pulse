import type { FastifyBaseLogger } from 'fastify';
import { errorMessage } from '../errors.js';

export interface LoopStatus {
  name: string;
  running: boolean;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface Loop {
  readonly name: string;
  status(): LoopStatus;
  /** Stops the loop, aborts the tick in flight through its signal, and resolves once it has finished. */
  stop(): Promise<void>;
}

export interface LoopOptions {
  name: string;
  /** Rest between ticks. Skipped when a tick reports there is more work waiting. */
  intervalMs: number;
  /** Longest rest while ticks keep failing (a DB outage must not produce one stack trace per second). */
  maxBackoffMs?: number;
  /** One unit of work. Return true to run the next tick immediately. The signal fires on stop(). */
  tick: (signal: AbortSignal) => Promise<boolean>;
  log: FastifyBaseLogger;
}

/**
 * Runs `tick` repeatedly. Unlike setInterval, ticks never overlap (a slow tick delays the next
 * one instead of running alongside it); a failing tick is logged, backed off exponentially and
 * never ends the loop; stop() is prompt because it both aborts the tick and wakes the sleep.
 */
export function startLoop({ name, intervalMs, maxBackoffMs = 30_000, tick, log }: LoopOptions): Loop {
  const controller = new AbortController();
  let running = true;
  let wake: (() => void) | undefined;
  let lastTickAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let consecutiveFailures = 0;
  let lastError: string | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });

  const finished = (async () => {
    while (running) {
      lastTickAt = new Date();
      let more: boolean;
      try {
        more = await tick(controller.signal);
        if (consecutiveFailures > 0) log.info({ failures: consecutiveFailures }, 'tick recovered');
        consecutiveFailures = 0;
        lastError = null;
        lastSuccessAt = new Date();
      } catch (err) {
        consecutiveFailures += 1;
        lastError = errorMessage(err);
        const delayMs = Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs);
        // Full detail on the first failure; after that one line per tick, without the stack.
        if (consecutiveFailures === 1) log.error({ err, delayMs }, 'tick failed');
        else log.warn({ err: lastError, failures: consecutiveFailures, delayMs }, 'tick still failing');
        if (running) await sleep(delayMs);
        continue;
      }
      if (!running || more) continue;
      await sleep(intervalMs);
    }
  })();

  return {
    name,
    status: () => ({
      name,
      running,
      lastTickAt: lastTickAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures,
      lastError,
    }),
    async stop() {
      running = false;
      controller.abort(new Error('shutting down'));
      wake?.();
      await finished;
    },
  };
}
