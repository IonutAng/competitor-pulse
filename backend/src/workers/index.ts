import type { FastifyBaseLogger } from 'fastify';
import type { Deps } from '../deps.js';
import type { Loop } from './loop.js';
import { PollWorker } from './poll-worker.js';

export async function startWorkers(deps: Deps, log: FastifyBaseLogger): Promise<Loop[]> {
  const poll = new PollWorker(deps, log.child({ worker: 'poll' }));
  await poll.prepare();
  return [poll.start()];
}
