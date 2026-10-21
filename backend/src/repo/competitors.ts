import { asc, eq } from 'drizzle-orm';
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
    const rows = await this.db.delete(competitors).where(eq(competitors.id, id)).returning({ id: competitors.id });
    return rows.length > 0;
  }
}
