import type { ListingField } from '../db/schema.js';

/** The four fields of a competitor's product listing, exactly as the data source returned them. */
export type Listing = Record<ListingField, string>;

/**
 * Where listings come from. The poll worker only ever talks to this interface, so swapping the
 * fixture stub for a real scraper or a vendor API touches nothing else.
 */
export interface ListingSource {
  /** Returns the competitor's current listing. Throws UnknownCompetitorError when the source has no such competitor. */
  fetchListing(id: string, signal?: AbortSignal): Promise<Listing>;
  /** Optional: discard any per-competitor state once the competitor is no longer tracked. */
  forget?(id: string): void;
}

export class UnknownCompetitorError extends Error {
  constructor(public readonly competitorId: string) {
    super(`Competitor "${competitorId}" not found in data source`);
    this.name = 'UnknownCompetitorError';
  }
}
