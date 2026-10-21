import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { competitors, snapshots, type SnapshotRow } from '../db/schema.js';
import { changedFields, contentHash } from '../domain/diff.js';
import type { Listing } from '../source/listing-source.js';

export interface ListOptions {
  /** Page size; omitted = everything. */
  limit?: number;
  /** Keyset cursor: only snapshots with an id below this one. */
  before?: number;
}

export interface PollResult {
  snapshot: SnapshotRow;
  /** The snapshot the new one was compared against; undefined for a competitor's first snapshot. */
  previous: SnapshotRow | undefined;
}

/** A claimed summary job: the snapshot to summarize and the attempt number this claim owns. */
export interface SummaryJob {
  id: number;
  attempt: number;
}

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

  async getById(id: number): Promise<SnapshotRow | undefined> {
    const rows = await this.db.select().from(snapshots).where(eq(snapshots.id, id)).limit(1);
    return rows[0];
  }

  /** A competitor's history, newest first. `id` is the ordering key (see schema.ts). */
  listByCompetitor(competitorId: string, options: ListOptions = {}): Promise<SnapshotRow[]> {
    const conditions = [eq(snapshots.competitorId, competitorId)];
    if (options.before !== undefined) conditions.push(lt(snapshots.id, options.before));
    let query = this.db
      .select()
      .from(snapshots)
      .where(and(...conditions))
      .orderBy(desc(snapshots.id))
      .$dynamic();
    if (options.limit !== undefined) query = query.limit(options.limit);
    return query;
  }

  /**
   * Records a fetched listing as a new snapshot, diffed against the competitor's latest stored
   * snapshot. The read and the insert happen under a per-competitor advisory lock, so two
   * overlapping polls of the same competitor (a "Poll now" during a scheduled poll, or two
   * instances) are serialized: the second one diffs against the first one's row instead of both
   * reporting the same change and queueing two LLM calls.
   *
   * Throws a foreign-key violation if the competitor was removed in the meantime.
   */
  recordPoll(competitorId: string, listing: Listing): Promise<PollResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${competitorId}))`);

      const [previous] = await tx
        .select()
        .from(snapshots)
        .where(eq(snapshots.competitorId, competitorId))
        .orderBy(desc(snapshots.id))
        .limit(1);

      const hash = contentHash(listing);
      const changed = previous !== undefined && previous.contentHash !== hash;
      const fields = changed ? changedFields(previous, listing) : [];

      const [snapshot] = await tx
        .insert(snapshots)
        .values({
          competitorId,
          title: listing.title,
          tagline: listing.tagline,
          price: listing.price,
          description: listing.description,
          contentHash: hash,
          previousSnapshotId: previous?.id ?? null,
          changed,
          changedFields: fields,
          // A change queues a summary job; the row itself is committed regardless of what the LLM does later.
          summaryStatus: changed ? 'pending' : 'none',
          summaryNextAttemptAt: changed ? sql`now()` : null,
        })
        .returning();

      await tx.update(competitors).set({ lastError: null }).where(eq(competitors.id, competitorId));

      return { snapshot: snapshot!, previous };
    });
  }

  // --- summary queue ----------------------------------------------------------------------
  //
  // The queue is the snapshots table itself: a changed snapshot starts out `pending` and is
  // claimed, completed or failed in place. Claims take a lease (summary_next_attempt_at pushed
  // into the future) and bump summary_attempts; every later write is fenced on that attempt
  // number, so a worker that lost its lease can never overwrite a newer claim.

  /**
   * Claims up to `limit` pending summaries that are due, leasing each for `leaseMs`. Same
   * SKIP LOCKED pattern as polling: safe across instances, never claims a job twice while its
   * lease is live. Jobs that already used all their attempts are left to reapExhausted().
   */
  async claimPendingSummaries(limit: number, maxAttempts: number, leaseMs: number): Promise<SummaryJob[]> {
    const result = await this.db.execute<{ id: string | number; attempt: number }>(sql`
      WITH due AS (
        SELECT id FROM snapshots
        WHERE summary_status = 'pending'
          AND summary_next_attempt_at <= now()
          AND summary_attempts < ${maxAttempts}
        ORDER BY summary_next_attempt_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE snapshots s
      SET summary_attempts = s.summary_attempts + 1,
          summary_next_attempt_at = now() + (${leaseMs}::int * interval '1 millisecond')
      FROM due
      WHERE s.id = due.id
      RETURNING s.id, s.summary_attempts AS attempt
    `);
    return result.rows.map((row) => ({ id: Number(row.id), attempt: Number(row.attempt) }));
  }

  /**
   * A job whose last attempt died mid-flight (process crash) stays `pending` with its attempts
   * used up and its lease expired. Nothing would ever claim it again, so mark it failed.
   */
  async reapExhaustedSummaries(maxAttempts: number): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE snapshots
      SET summary_status = 'failed',
          summary_next_attempt_at = NULL,
          summary_error = COALESCE(summary_error, 'gave up: all attempts used')
      WHERE summary_status = 'pending'
        AND summary_attempts >= ${maxAttempts}
        AND summary_next_attempt_at <= now()
    `);
    return result.rowCount ?? 0;
  }

  /** Stores a summary. Returns false if the job was re-claimed by someone else or removed meanwhile. */
  async completeSummary(id: number, attempt: number, summary: string): Promise<boolean> {
    const rows = await this.db
      .update(snapshots)
      .set({ summary, summaryStatus: 'done', summaryNextAttemptAt: null, summaryError: null })
      .where(this.fence(id, attempt))
      .returning({ id: snapshots.id });
    return rows.length > 0;
  }

  /**
   * Records a failed attempt. With `retryInMs` the job goes back to the queue for that long;
   * with null it is failed for good. Returns false if the fence rejected the write.
   */
  async failSummary(id: number, attempt: number, error: string, retryInMs: number | null): Promise<boolean> {
    const rows = await this.db
      .update(snapshots)
      .set(
        retryInMs === null
          ? { summaryStatus: 'failed', summaryNextAttemptAt: null, summaryError: error }
          : {
              summaryStatus: 'pending',
              summaryNextAttemptAt: sql`now() + (${retryInMs}::int * interval '1 millisecond')`,
              summaryError: error,
            },
      )
      .where(this.fence(id, attempt))
      .returning({ id: snapshots.id });
    return rows.length > 0;
  }

  private fence(id: number, attempt: number) {
    return and(eq(snapshots.id, id), eq(snapshots.summaryStatus, 'pending'), eq(snapshots.summaryAttempts, attempt));
  }
}
