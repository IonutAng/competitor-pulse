import type { FastifyBaseLogger } from 'fastify';
import type { Deps } from '../deps.js';
import type { Loop } from './loop.js';
import { PollWorker } from './poll-worker.js';
import { SummaryWorker } from './summary-worker.js';

export async function startWorkers(deps: Deps, log: FastifyBaseLogger): Promise<Loop[]> {
  const poll = new PollWorker(deps, log.child({ worker: 'poll' }));
  await poll.prepare();
  const summary = new SummaryWorker(deps, log.child({ worker: 'summary' }));
  return [poll.start(), summary.start()];
}
