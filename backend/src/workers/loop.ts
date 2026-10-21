import type { FastifyBaseLogger } from 'fastify';

export interface Loop {
  /** Stops the loop and resolves once the tick in flight (if any) has finished. */
  stop(): Promise<void>;
}

export interface LoopOptions {
  name: string;
  /** Rest between ticks. Skipped when a tick reports there is more work waiting. */
  intervalMs: number;
  /** One unit of work. Return true to run the next tick immediately. */
  tick: () => Promise<boolean | void>;
  log: FastifyBaseLogger;
}

/**
 * Runs `tick` repeatedly. Unlike setInterval, ticks never overlap (a slow tick delays the next
 * one instead of running alongside it), and a failing tick is logged and does not end the loop.
 */
export function startLoop({ name, intervalMs, tick, log }: LoopOptions): Loop {
  let running = true;
  let wake: (() => void) | undefined;

  const finished = (async () => {
    while (running) {
      let more = false;
      try {
        more = (await tick()) === true;
      } catch (err) {
        log.error({ err, loop: name }, 'tick failed');
      }
      if (!running || more) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();

  return {
    async stop() {
      running = false;
      wake?.();
      await finished;
    },
  };
}
