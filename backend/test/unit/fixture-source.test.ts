import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureListingSource } from '../../src/source/fixture-source.js';
import { UnknownCompetitorError, type Listing } from '../../src/source/listing-source.js';

const PROVIDED_FIXTURES = fileURLToPath(new URL('../../fixtures/listings.json', import.meta.url));

const priced = (price: string): Listing => ({ title: 'Acme', tagline: 'tag', price, description: 'desc' });

async function prices(source: FixtureListingSource, id: string, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push((await source.fetchListing(id)).price);
  return out;
}

describe('FixtureListingSource', () => {
  it('serves each version in order, then repeats the last one forever', async () => {
    const source = new FixtureListingSource(new Map([['acme', [priced('$1'), priced('$2'), priced('$3')]]]));
    expect(await prices(source, 'acme', 6)).toEqual(['$1', '$2', '$3', '$3', '$3', '$3']);
  });

  it('keeps an independent cursor per competitor', async () => {
    const source = new FixtureListingSource(
      new Map([
        ['a', [priced('a1'), priced('a2')]],
        ['b', [priced('b1'), priced('b2')]],
      ]),
    );
    expect(await prices(source, 'a', 2)).toEqual(['a1', 'a2']);
    expect(await prices(source, 'b', 1)).toEqual(['b1']);
  });

  it('rejects ids it does not know', async () => {
    const source = new FixtureListingSource(new Map([['acme', [priced('$1')]]]));
    await expect(source.fetchListing('ghost')).rejects.toBeInstanceOf(UnknownCompetitorError);
  });

  it('forget() restarts the sequence for that competitor only', async () => {
    const source = new FixtureListingSource(
      new Map([
        ['a', [priced('a1'), priced('a2')]],
        ['b', [priced('b1'), priced('b2')]],
      ]),
    );
    await prices(source, 'a', 2);
    await prices(source, 'b', 1);
    source.forget('a');
    expect(await prices(source, 'a', 1)).toEqual(['a1']);
    expect(await prices(source, 'b', 1)).toEqual(['b2']);
  });

  it('returns copies, so a caller cannot corrupt later versions', async () => {
    const source = new FixtureListingSource(new Map([['acme', [priced('$1')]]]));
    const first = await source.fetchListing('acme');
    first.price = 'mutated';
    expect((await source.fetchListing('acme')).price).toBe('$1');
  });

  it('loads the provided fixtures: 3 competitors, 4 distinct consecutive versions each', async () => {
    const source = FixtureListingSource.fromFile(PROVIDED_FIXTURES);
    expect([...source.competitorIds].sort()).toEqual(['acme-crm', 'ferry-pay', 'north-analytics']);
    for (const id of source.competitorIds) {
      const seen: string[] = [];
      for (let i = 0; i < 5; i++) seen.push(JSON.stringify(await source.fetchListing(id)));
      expect(new Set(seen.slice(0, 4)).size, id).toBe(4);
      expect(seen[4], id).toBe(seen[3]);
    }
  });
});
