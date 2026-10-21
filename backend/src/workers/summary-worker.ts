import type { FastifyBaseLogger } from 'fastify';
import type { Deps } from '../deps.js';
import { decideRetry } from '../domain/retry.js';
import { errorMessage } from '../errors.js';
import type { SummaryJob } from '../repo/snapshots.js';
import { startLoop, type Loop } from './loop.js';

/** A lease outlives the LLM timeout by this much, so a call that is still running can never be claimed again. */
const LEASE_GRACE_MS = 5000;

/** Timeouts surface as abort errors with no useful text ("Request was aborted."); say what happened. */
function describeLlmError(err: unknown, timeoutMs: number): string {
  const kind = err instanceof Error ? err.constructor.name : '';
  const message = errorMessage(err);
  if (
    ['AbortError', 'TimeoutError', 'APIUserAbortError', 'APIConnectionTimeoutError'].includes(kind) ||
    /aborted|timed out/i.test(message)
  ) {
    return `LLM call timed out after ${timeoutMs} ms`;
  }
  return message;
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
      tick: () => this.tick(),
    });
  }

  /** Reaps dead jobs, then claims and runs one batch. Returns true when the batch was full. */
  async tick(): Promise<boolean> {
    const { config, snapshots } = this.deps;
    const reaped = await snapshots.reapExhaustedSummaries(config.LLM_MAX_ATTEMPTS);
    if (reaped > 0) this.log.warn({ reaped }, 'summaries marked failed: all attempts used without a result');

    const jobs = await snapshots.claimPendingSummaries(
      config.SUMMARY_CONCURRENCY,
      config.LLM_MAX_ATTEMPTS,
      config.LLM_TIMEOUT_MS + LEASE_GRACE_MS,
    );
    if (jobs.length === 0) return false;
    await Promise.all(jobs.map((job) => this.summarizeOne(job)));
    return jobs.length >= config.SUMMARY_CONCURRENCY;
  }

  /** Runs one claimed job. Never throws: outcomes are written to the snapshot row. */
  async summarizeOne({ id, attempt }: SummaryJob): Promise<void> {
    const { config, snapshots, summarizer } = this.deps;
    const log = this.log.child({ snapshotId: id, attempt });

    const snapshot = await snapshots.getById(id);
    if (!snapshot) {
      log.info('snapshot was removed before it could be summarized');
      return;
    }
    const previous =
      snapshot.previousSnapshotId === null ? undefined : await snapshots.getById(snapshot.previousSnapshotId);
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

    try {
      const summary = await summarizer.summarize(
        previous,
        snapshot,
        snapshot.changedFields,
        AbortSignal.timeout(config.LLM_TIMEOUT_MS),
      );
      const stored = await snapshots.completeSummary(id, attempt, summary);
      if (stored) log.info('summary stored');
      else log.warn('summary discarded: the job was re-claimed or removed while the LLM was running');
    } catch (err) {
      const message = describeLlmError(err, config.LLM_TIMEOUT_MS);
      const decision = decideRetry(attempt, config.LLM_MAX_ATTEMPTS, err, {
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
}
