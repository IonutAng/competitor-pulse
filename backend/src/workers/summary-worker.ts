import type { FastifyBaseLogger } from 'fastify';
import { LISTING_FIELDS, type SnapshotRow } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { decideRetry } from '../domain/retry.js';
import { errorMessage } from '../errors.js';
import { isTransientSummarizerError } from '../llm/summarizer.js';
import type { SummaryJob } from '../repo/snapshots.js';
import type { Listing } from '../source/listing-source.js';
import { startLoop, type Loop } from './loop.js';

/** A lease outlives the LLM timeout by this much, so a call that is still running can never be claimed again. */
const LEASE_GRACE_MS = 5000;

/** Only the four listing fields leave the worker; the rest of the row is none of the model's business. */
function toListing(row: SnapshotRow): Listing {
  const listing = {} as Listing;
  for (const field of LISTING_FIELDS) listing[field] = row[field];
  return listing;
}

/**
 * Turns pending snapshots into AI summaries. Runs independently of polling, so a slow or dead
 * LLM delays summaries but never delays or loses snapshots. Delivery is at-least-once: a job is
 * retried after a crash or a failure (with backoff, up to LLM_MAX_ATTEMPTS), and every write is
 * fenced on the attempt number so a stale worker cannot clobber a newer claim.
 */
export class SummaryWorker {
  constructor(
    private readonly deps: Deps,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): Loop {
    return startLoop({
      name: 'summary',
      intervalMs: this.deps.config.SUMMARY_TICK_MS,
      log: this.log,
      tick: (signal) => this.tick(signal),
    });
  }

  /** Reaps dead jobs, then claims and runs one batch. Returns true when the batch was full. */
  async tick(signal?: AbortSignal): Promise<boolean> {
    const { config, snapshots } = this.deps;
    const reaped = await snapshots.reapExhaustedSummaries(config.LLM_MAX_ATTEMPTS);
    if (reaped > 0) this.log.warn({ reaped }, 'summaries marked failed: all attempts used without a result');

    const jobs = await snapshots.claimPendingSummaries(
      config.SUMMARY_CONCURRENCY,
      config.LLM_MAX_ATTEMPTS,
      config.LLM_TIMEOUT_MS + LEASE_GRACE_MS,
    );
    if (jobs.length === 0) return false;
    const results = await Promise.allSettled(jobs.map((job) => this.summarizeOne(job, signal)));
    for (const result of results) {
      if (result.status === 'rejected')
        this.log.error({ err: result.reason }, 'summarizeOne threw unexpectedly');
    }
    return jobs.length >= config.SUMMARY_CONCURRENCY;
  }

  /**
   * Runs one claimed job. Never throws: an LLM failure is recorded on the row (retry or give up),
   * and a database failure is logged — the lease expires and the job is claimed again.
   */
  async summarizeOne({ id, attempt }: SummaryJob, signal?: AbortSignal): Promise<void> {
    const { snapshots, summarizer } = this.deps;
    const log = this.log.child({ snapshotId: id, attempt });
    try {
      const snapshot = await snapshots.getById(id);
      if (!snapshot) {
        log.info('snapshot was removed before it could be summarized');
        return;
      }
      const previous =
        snapshot.previousSnapshotId === null
          ? undefined
          : await snapshots.getById(snapshot.previousSnapshotId);
      if (!previous) {
        // Cannot happen through recordPoll (only diffs against a previous row are "changed"), but a
        // job must always end in a terminal state.
        await snapshots.failSummary(
          id,
          attempt,
          'previous snapshot is missing; nothing to compare against',
          null,
        );
        log.error('summary failed: previous snapshot missing');
        return;
      }

      let summary: string;
      try {
        summary = await summarizer.summarize(
          toListing(previous),
          toListing(snapshot),
          snapshot.changedFields,
          signal,
        );
      } catch (err) {
        await this.recordFailure(id, attempt, err, log);
        return;
      }
      const stored = await snapshots.completeSummary(id, attempt, summary);
      if (stored) log.info('summary stored');
      else log.warn('summary discarded: the job was re-claimed or removed while the LLM was running');
    } catch (err) {
      log.error(
        { err },
        'summary job failed outside the LLM call; it will be re-claimed when its lease expires',
      );
    }
  }

  private async recordFailure(
    id: number,
    attempt: number,
    err: unknown,
    log: FastifyBaseLogger,
  ): Promise<void> {
    const { config, snapshots } = this.deps;
    const message = errorMessage(err);
    const decision = decideRetry(attempt, config.LLM_MAX_ATTEMPTS, isTransientSummarizerError(err), {
      baseDelayMs: config.SUMMARY_BACKOFF_BASE_MS,
      maxDelayMs: config.SUMMARY_BACKOFF_MAX_MS,
    });
    if (decision.outcome === 'retry') {
      await snapshots.failSummary(id, attempt, message, decision.delayMs);
      log.warn({ err, retryInMs: decision.delayMs }, 'summary attempt failed; will retry');
    } else {
      await snapshots.failSummary(id, attempt, `${message} (${decision.reason})`, null);
      log.error({ err, reason: decision.reason }, 'summary failed permanently');
    }
  }
}
