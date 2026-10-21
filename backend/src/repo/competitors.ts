import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { competitors, type CompetitorRow } from '../db/schema.js';

export class CompetitorRepo {
  constructor(private readonly db: Db) {}

  list(): Promise<CompetitorRow[]> {
    return this.db.select().from(competitors).orderBy(asc(competitors.createdAt), asc(competitors.id));
  }

  async get(id: string): Promise<CompetitorRow | undefined> {
    const rows = await this.db.select().from(competitors).where(eq(competitors.id, id)).limit(1);
    return rows[0];
  }

  /** Starts tracking a competitor. Returns undefined when the id is already tracked. */
  async insert(id: string): Promise<CompetitorRow | undefined> {
    const rows = await this.db.insert(competitors).values({ id }).onConflictDoNothing().returning();
    return rows[0];
  }

  /** Stops tracking a competitor; its snapshots go with it (ON DELETE CASCADE). Returns whether it existed. */
  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(competitors)
      .where(eq(competitors.id, id))
      .returning({ id: competitors.id });
    return rows.length > 0;
  }

  // --- scheduling -------------------------------------------------------------------------

  /**
   * Claims up to `limit` competitors that are due and schedules their next poll `intervalMs`
   * from now, in one atomic statement. FOR UPDATE SKIP LOCKED lets any number of worker
   * instances run this concurrently without ever claiming the same competitor twice.
   * Scheduling from now() (not from the previous due time) means downtime never causes a
   * catch-up burst.
   */
  async claimDue(limit: number, intervalMs: number): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM competitors
        WHERE next_poll_at <= now()
        ORDER BY next_poll_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE competitors c
      SET next_poll_at = now() + (${intervalMs}::int * interval '1 millisecond'),
          last_polled_at = now()
      FROM due
      WHERE c.id = due.id
      RETURNING c.id
    `);
    return result.rows.map((row) => row.id);
  }

  /** Makes a competitor due immediately ("Poll now"). Returns the new due time, or undefined if not tracked. */
  async requestPoll(id: string): Promise<Date | undefined> {
    const rows = await this.db
      .update(competitors)
      .set({ nextPollAt: sql`now()` })
      .where(eq(competitors.id, id))
      .returning({ nextPollAt: competitors.nextPollAt });
    return rows[0]?.nextPollAt;
  }

  async recordError(id: string, message: string): Promise<void> {
    await this.db.update(competitors).set({ lastError: message }).where(eq(competitors.id, id));
  }

  /**
   * Run once when the poll worker starts: rows scheduled under a longer interval are pulled in
   * so a lowered POLL_INTERVAL_MS takes effect now, not after the old interval has elapsed.
   */
  async clampNextPoll(intervalMs: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE competitors
      SET next_poll_at = LEAST(next_poll_at, now() + (${intervalMs}::int * interval '1 millisecond'))
    `);
  }
}
