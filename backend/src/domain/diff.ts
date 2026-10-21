import { createHash } from 'node:crypto';
import { LISTING_FIELDS, type ListingField } from '../db/schema.js';
import type { Listing } from '../source/listing-source.js';

/**
 * The comparison form of a listing: trimmed, internal whitespace collapsed. Snapshots store the
 * raw text, but formatting-only edits are not changes worth a diff or an LLM call.
 */
export function canonicalize(listing: Listing): Listing {
  const out = {} as Listing;
  for (const field of LISTING_FIELDS) {
    out[field] = listing[field].trim().replace(/\s+/g, ' ');
  }
  return out;
}

/** Stable hash of the canonical listing. Two listings are "the same" iff their hashes match. */
export function contentHash(listing: Listing): string {
  const canonical = canonicalize(listing);
  const material = JSON.stringify(LISTING_FIELDS.map((field) => canonical[field]));
  return createHash('sha256').update(material).digest('hex');
}

/** Fields whose canonical value differs, always in LISTING_FIELDS order. */
export function changedFields(previous: Listing, current: Listing): ListingField[] {
  const before = canonicalize(previous);
  const after = canonicalize(current);
  return LISTING_FIELDS.filter((field) => before[field] !== after[field]);
}
