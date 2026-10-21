import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLoop } from '../../src/workers/loop.js';
import { silentLog } from '../helpers/log.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never overlaps ticks: a slow tick delays the next one', async () => {
    let running = 0;
    let maxRunning = 0;
    const tick = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await wait(500);
      running -= 1;
      return false;
    });
    const loop = startLoop({ name: 't', intervalMs: 100, tick, log: silentLog });

    // tick 0–500, rest 500–600, tick 600–1100, rest 1100–1200, tick 1200–...
    await vi.advanceTimersByTimeAsync(1250);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(maxRunning).toBe(1);

    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
  });

  it('runs the next tick immediately while a tick reports more work', async () => {
    const answers = [true, true, false];
    const tick = vi.fn(async () => answers.shift() ?? false);
    const loop = startLoop({ name: 't', intervalMs: 10_000, tick, log: silentLog });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(3);
    await loop.stop();
  });

  it('backs off while ticks keep failing, then recovers', async () => {
    let down = true;
    const tick = vi.fn(async () => {
      if (down) throw new Error('db down');
      return false;
    });
    const loop = startLoop({ name: 't', intervalMs: 100, maxBackoffMs: 1000, tick, log: silentLog });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.status()).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'db down',
      lastSuccessAt: null,
    });

    await vi.advanceTimersByTimeAsync(199); // 1st failure → 200 ms
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400); // 2nd failure → 400 ms
    expect(tick).toHaveBeenCalledTimes(3);

    down = false;
    await vi.advanceTimersByTimeAsync(800); // 3rd failure → 800 ms
    expect(tick).toHaveBeenCalledTimes(4);
    expect(loop.status()).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(loop.status().lastSuccessAt).not.toBeNull();

    await loop.stop();
  });

  it('stop() during the rest resolves at once and aborts the signal handed to ticks', async () => {
    let seen: AbortSignal | undefined;
    const tick = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      return false;
    });
    const loop = startLoop({ name: 't', intervalMs: 60_000, tick, log: silentLog });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await loop.stop(); // no timers advanced: the sleep was woken
    expect(seen?.aborted).toBe(true);
    expect(loop.status().running).toBe(false);
  });

  it('stop() during a tick waits for that tick to finish', async () => {
    let finished = false;
    const tick = async () => {
      await wait(300);
      finished = true;
      return false;
    };
    const loop = startLoop({ name: 't', intervalMs: 100, tick, log: silentLog });
    await vi.advanceTimersByTimeAsync(10);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
  });
});
