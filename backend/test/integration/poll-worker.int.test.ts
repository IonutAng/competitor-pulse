import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/deps.js';
import { FixtureListingSource } from '../../src/source/fixture-source.js';
import type { Listing, ListingSource } from '../../src/source/listing-source.js';
import { PollWorker } from '../../src/workers/poll-worker.js';
import { buildTestApp, testDeps } from '../helpers/app.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';
import { v1, v2, v3 } from '../helpers/listings.js';

describe('PollWorker', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
  });
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  function worker(source: ListingSource, env: NodeJS.ProcessEnv = {}): { deps: Deps; worker: PollWorker } {
    const deps = testDeps(t.db, env, { source });
    return { deps, worker: new PollWorker(deps, buildTestApp(deps).log) };
  }

  it('records initial, changed and unchanged snapshots, queueing a summary only for real changes', async () => {
    const source = new FixtureListingSource(new Map([['acme', [v1, v2, v2, v3]]]));
    const { deps, worker: w } = worker(source);
    await deps.competitors.insert('acme');

    for (let i = 0; i < 4; i++) await w.pollOne('acme');

    const rows = await deps.snapshots.listByCompetitor('acme');
    expect(rows).toHaveLength(4);
    const [s4, s3, s2, s1] = rows;

    expect(s1).toMatchObject({
      previousSnapshotId: null,
      changed: false,
      changedFields: [],
      summaryStatus: 'none',
      summaryNextAttemptAt: null,
      price: '$29/mo',
    });
    expect(s2).toMatchObject({
      previousSnapshotId: s1!.id,
      changed: true,
      changedFields: ['price'],
      summaryStatus: 'pending',
      price: '$39/mo',
    });
    expect(s2!.summaryNextAttemptAt).toBeInstanceOf(Date);
    expect(s3).toMatchObject({ previousSnapshotId: s2!.id, changed: false, summaryStatus: 'none' });
    expect(s4).toMatchObject({
      previousSnapshotId: s3!.id,
      changed: true,
      changedFields: ['tagline', 'description'],
      summaryStatus: 'pending',
    });

    // Newest first, and fetched_at never runs backwards along the chain.
    expect(rows.map((r) => r.id)).toEqual([s4!.id, s3!.id, s2!.id, s1!.id]);
    expect(s4!.fetchedAt.getTime()).toBeGreaterThanOrEqual(s1!.fetchedAt.getTime());
  });

  it('treats whitespace-only differences as no change', async () => {
    const noisy: Listing = { ...v1, title: `  ${v1.title}  `, description: `${v1.description}\n\n` };
    const { deps, worker: w } = worker(new FixtureListingSource(new Map([['acme', [v1, noisy]]])));
    await deps.competitors.insert('acme');
    await w.pollOne('acme');
    await w.pollOne('acme');
    const [latest] = await deps.snapshots.listByCompetitor('acme');
    expect(latest).toMatchObject({ changed: false, summaryStatus: 'none', title: noisy.title });
  });

  it('records a fetch failure on the competitor without a snapshot, and clears it on the next success', async () => {
    let failNext = true;
    const flaky: ListingSource = {
      async fetchListing(id) {
        if (failNext) {
          failNext = false;
          throw new Error('connection reset');
        }
        return { ...v1, title: id };
      },
    };
    const { deps, worker: w } = worker(flaky);
    await deps.competitors.insert('acme');

    await w.pollOne('acme');
    expect((await deps.competitors.get('acme'))?.lastError).toBe('Fetch failed: connection reset');
    expect(await deps.snapshots.listByCompetitor('acme')).toEqual([]);

    await w.pollOne('acme');
    expect((await deps.competitors.get('acme'))?.lastError).toBeNull();
    expect(await deps.snapshots.listByCompetitor('acme')).toHaveLength(1);
  });

  it('reports ids the data source does not know', async () => {
    const { deps, worker: w } = worker(new FixtureListingSource(new Map([['acme', [v1]]])));
    await deps.competitors.insert('ghost');
    await w.pollOne('ghost');
    expect((await deps.competitors.get('ghost'))?.lastError).toMatch(/not found in data source/);
  });

  it('tick() polls only what is due and says whether more may be waiting', async () => {
    const { deps, worker: w } = worker(new FixtureListingSource(new Map([['acme', [v1, v2]]])), {
      POLL_BATCH_SIZE: '1',
    });
    await deps.competitors.insert('acme');
    await deps.competitors.insert('ghost');

    expect(await w.tick()).toBe(true); // batch of 1 was full
    expect(await w.tick()).toBe(true);
    expect(await w.tick()).toBe(false); // nothing due any more
    expect(await deps.snapshots.listByCompetitor('acme')).toHaveLength(1);
    expect((await deps.competitors.get('ghost'))?.lastError).toMatch(/not found/);

    await deps.competitors.requestPoll('acme');
    expect(await w.tick()).toBe(true);
    expect(await deps.snapshots.listByCompetitor('acme')).toHaveLength(2);
  });

  it('drops the result when the competitor was removed while being polled', async () => {
    const { deps, worker: w } = worker({
      async fetchListing(id) {
        await deps.competitors.delete(id);
        return v1;
      },
    });
    await deps.competitors.insert('acme');
    await expect(w.pollOne('acme')).resolves.toBeUndefined();
    expect(await deps.snapshots.listByCompetitor('acme')).toEqual([]);
  });

  it('serializes overlapping polls of the same competitor so each diff sees the previous row', async () => {
    const { deps, worker: w } = worker(new FixtureListingSource(new Map([['acme', [v1, v2]]])));
    await deps.competitors.insert('acme');
    await Promise.all([w.pollOne('acme'), w.pollOne('acme')]);

    const rows = await deps.snapshots.listByCompetitor('acme');
    expect(rows).toHaveLength(2);
    const [second, first] = rows;
    // Without the per-competitor lock both polls would read "no previous snapshot" and both be initial.
    expect(first!.previousSnapshotId).toBeNull();
    expect(second!.previousSnapshotId).toBe(first!.id);
    expect(second!.changed).toBe(true);
  });
});
