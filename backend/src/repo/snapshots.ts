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

export class SnapshotRepo {
  constructor(private readonly db: Db) {}

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
}
