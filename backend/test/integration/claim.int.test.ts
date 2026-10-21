import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompetitorRepo } from '../../src/repo/competitors.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CompetitorRepo scheduling', () => {
  let t: TestDb;
  let repo: CompetitorRepo;

  beforeAll(async () => {
    t = await setupTestDb();
    repo = new CompetitorRepo(t.db);
  });
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  it('two concurrent claimers get disjoint sets that together cover everything due', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `comp-${i}`);
    for (const id of ids) await repo.insert(id);

    const [a, b] = await Promise.all([repo.claimDue(5, 60_000), repo.claimDue(5, 60_000)]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b]).size).toBe(10);

    // Everything is now scheduled a minute out: nothing left to claim.
    expect(await repo.claimDue(10, 60_000)).toEqual([]);
    const row = await repo.get('comp-0');
    expect(row?.lastPolledAt).toBeInstanceOf(Date);
    expect(row!.nextPollAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('a claimed competitor becomes due again after its interval', async () => {
    await repo.insert('acme');
    expect(await repo.claimDue(10, 1000)).toEqual(['acme']);
    expect(await repo.claimDue(10, 1000)).toEqual([]);
    await sleep(1100);
    expect(await repo.claimDue(10, 1000)).toEqual(['acme']);
  });

  it('requestPoll makes a competitor due immediately', async () => {
    await repo.insert('acme');
    await repo.claimDue(10, 60_000);
    const nextPollAt = await repo.requestPoll('acme');
    expect(nextPollAt).toBeInstanceOf(Date);
    expect(await repo.claimDue(10, 60_000)).toEqual(['acme']);
    expect(await repo.requestPoll('ghost')).toBeUndefined();
  });

  it('clampNextPoll pulls polls scheduled under a longer interval in to the new one', async () => {
    await repo.insert('acme');
    await repo.claimDue(10, 3_600_000);
    await repo.clampNextPoll(1000);
    const row = await repo.get('acme');
    expect(row!.nextPollAt.getTime()).toBeLessThanOrEqual(Date.now() + 1500);
  });
});
