import type { FastifyBaseLogger } from 'fastify';
import type { Deps } from '../deps.js';
import type { Loop } from './loop.js';
import { PollWorker } from './poll-worker.js';
import { SummaryWorker } from './summary-worker.js';

/** Starts both background loops and registers them in deps.runtime so /health can report on them. */
export async function startWorkers(deps: Deps, log: FastifyBaseLogger): Promise<Loop[]> {
  const poll = new PollWorker(deps, log.child({ worker: 'poll' }));
  await poll.prepare();
  const summary = new SummaryWorker(deps, log.child({ worker: 'summary' }));
  const loops = [poll.start(), summary.start()];
  deps.runtime.loops.push(...loops);
  return loops;
}
