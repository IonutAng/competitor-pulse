import type { FastifyBaseLogger } from 'fastify';
import pLimit from 'p-limit';
import type { Deps } from '../deps.js';
import { PG_FOREIGN_KEY_VIOLATION, errorMessage, pgErrorCode } from '../errors.js';
import { UnknownCompetitorError } from '../source/listing-source.js';
import { startLoop, type Loop } from './loop.js';

/**
 * Polls tracked competitors. Every tick claims the competitors that are due (one atomic
 * statement, safe with several instances), fetches their listings with bounded concurrency and
 * records a snapshot for each.
 *
 * Polling is at-most-once per interval: if the process dies between the claim and the insert,
 * nothing is corrupted and the competitor is simply polled again one interval later. Polling
 * samples a level, so a delayed sample is still a correct sample; summaries, which must not be
 * dropped, use the at-least-once queue in summary-worker.ts instead.
 */
export class PollWorker {
  constructor(
    private readonly deps: Deps,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Run once before the loop so a lowered POLL_INTERVAL_MS applies immediately. */
  async prepare(): Promise<void> {
    await this.deps.competitors.clampNextPoll(this.deps.config.POLL_INTERVAL_MS);
  }

  start(): Loop {
    return startLoop({
      name: 'poll',
      intervalMs: this.deps.config.SCHEDULER_TICK_MS,
      log: this.log,
      tick: () => this.tick(),
    });
  }

  /** Claims and polls one batch. Returns true when the batch was full, i.e. more competitors may be due. */
  async tick(): Promise<boolean> {
    const { config, competitors } = this.deps;
    const ids = await competitors.claimDue(config.POLL_BATCH_SIZE, config.POLL_INTERVAL_MS);
    if (ids.length === 0) return false;
    const limit = pLimit(config.POLL_CONCURRENCY);
    await Promise.all(ids.map((id) => limit(() => this.pollOne(id))));
    return ids.length >= config.POLL_BATCH_SIZE;
  }

  /** Fetches one competitor's listing and records it. Never throws: failures land in competitors.last_error. */
  async pollOne(id: string): Promise<void> {
    const { config, source, snapshots, competitors } = this.deps;
    const log = this.log.child({ competitorId: id });
    try {
      const listing = await source.fetchListing(id, AbortSignal.timeout(config.SOURCE_TIMEOUT_MS));
      const { snapshot, previous } = await snapshots.recordPoll(id, listing);
      const outcome =
        previous === undefined ? 'initial snapshot' : snapshot.changed ? 'listing changed' : 'listing unchanged';
      log.info({ snapshotId: snapshot.id, changedFields: snapshot.changedFields }, outcome);
    } catch (err) {
      if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
        log.info('competitor was removed while being polled; result dropped');
        return;
      }
      const message = err instanceof UnknownCompetitorError ? err.message : `Fetch failed: ${errorMessage(err)}`;
      log.warn({ err }, 'poll failed');
      await competitors
        .recordError(id, message)
        .catch((recordErr) => log.error({ err: recordErr }, 'could not record the poll error'));
    }
  }
}
