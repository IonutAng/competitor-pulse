import { describe, expect, it } from 'vitest';
import { canonicalize, changedFields, contentHash } from '../../src/domain/diff.js';
import { v1, v2, v3 } from '../helpers/listings.js';

describe('diff', () => {
  it('identical listings hash the same and have no changed fields', () => {
    expect(contentHash(v1)).toBe(contentHash({ ...v1 }));
    expect(changedFields(v1, { ...v1 })).toEqual([]);
  });

  it('ignores whitespace-only differences', () => {
    const noisy = { ...v1, title: '  Acme   CRM ', description: `${v1.description}\n` };
    expect(canonicalize(noisy)).toEqual(v1);
    expect(contentHash(noisy)).toBe(contentHash(v1));
    expect(changedFields(v1, noisy)).toEqual([]);
  });

  it('reports exactly the fields whose content differs, in a fixed order', () => {
    expect(changedFields(v1, v2)).toEqual(['price']);
    expect(changedFields(v2, v3)).toEqual(['tagline', 'description']);
    // Order comes from LISTING_FIELDS, not from which field changed "first".
    expect(changedFields(v3, v2)).toEqual(['tagline', 'description']);
    expect(changedFields(v1, v3)).toEqual(['tagline', 'price', 'description']);
  });

  it('changes the hash whenever any field changes', () => {
    expect(contentHash(v1)).not.toBe(contentHash(v2));
    expect(contentHash(v2)).not.toBe(contentHash(v3));
  });

  it('hashes by field, independent of object key order', () => {
    const reordered = { description: v1.description, price: v1.price, tagline: v1.tagline, title: v1.title };
    expect(contentHash(reordered)).toBe(contentHash(v1));
  });

  it('does not let one field bleed into the next', () => {
    const a = { ...v1, title: 'ab', tagline: 'c' };
    const b = { ...v1, title: 'a', tagline: 'bc' };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});
