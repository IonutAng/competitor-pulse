import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { type Listing, type ListingSource, UnknownCompetitorError } from './listing-source.js';

const listingSchema = z.object({
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
});
const fixturesSchema = z.record(z.string(), z.array(listingSchema).min(1));

/**
 * Stand-in for scraping real competitor pages. Each call for an id returns the next canned
 * version of its listing; once the sequence is exhausted the last version repeats forever,
 * which is what a stable live page looks like to the poller.
 *
 * The cursor lives in memory on purpose: it simulates the state of the outside world, not of
 * this system, so it is not persisted (a restart replays the sequence).
 */
export class FixtureListingSource implements ListingSource {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly versions: ReadonlyMap<string, readonly Listing[]>) {}

  static fromFile(path: string): FixtureListingSource {
    const parsed = fixturesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return new FixtureListingSource(new Map(Object.entries(parsed)));
  }

  get competitorIds(): string[] {
    return [...this.versions.keys()];
  }

  async fetchListing(id: string): Promise<Listing> {
    const sequence = this.versions.get(id);
    if (!sequence) throw new UnknownCompetitorError(id);
    const cursor = this.cursors.get(id) ?? 0;
    const listing = sequence[Math.min(cursor, sequence.length - 1)]!; // sequences are never empty
    this.cursors.set(id, Math.min(cursor + 1, sequence.length));
    return { ...listing };
  }

  /** Re-adding a removed competitor replays its sequence from the first version. */
  forget(id: string): void {
    this.cursors.delete(id);
  }
}
