import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/deps.js';
import { FixtureListingSource } from '../../src/source/fixture-source.js';
import { PollWorker } from '../../src/workers/poll-worker.js';
import { SummaryWorker } from '../../src/workers/summary-worker.js';
import { buildTestApp, testDeps } from '../helpers/app.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';
import { v1, v2, v3 } from '../helpers/listings.js';
import { FakeSummarizer, httpError } from '../helpers/summarizer.js';

describe('SummaryWorker', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
  });
  beforeEach(() => t.reset());
  afterAll(() => t.close());

  function setup(summarizer: FakeSummarizer, env: NodeJS.ProcessEnv = {}) {
    const source = new FixtureListingSource(new Map([['acme', [v1, v2, v3]]]));
    const deps = testDeps(t.db, env, { source, summarizer });
    const log = buildTestApp(deps).log;
    return { deps, poll: new PollWorker(deps, log), worker: new SummaryWorker(deps, log) };
  }

  /** Polls twice so there is one changed snapshot (v1 -> v2) waiting for a summary. */
  async function changedSnapshot(deps: Deps, poll: PollWorker) {
    await deps.competitors.insert('acme');
    await poll.pollOne('acme');
    await poll.pollOne('acme');
    const [latest] = await deps.snapshots.listByCompetitor('acme');
    expect(latest?.summaryStatus).toBe('pending');
    return latest!;
  }

  const makeDue = (id: number) =>
    t.db.execute(sql`UPDATE snapshots SET summary_next_attempt_at = now() - interval '1 second' WHERE id = ${id}`);

  it('stores the summary and marks the job done', async () => {
    const summarizer = new FakeSummarizer(async () => 'Price rose from $29/mo to $39/mo.');
    const { deps, poll, worker } = setup(summarizer);
    const pending = await changedSnapshot(deps, poll);

    expect(await worker.tick()).toBe(false);

    const done = await deps.snapshots.getById(pending.id);
    expect(done).toMatchObject({
      summaryStatus: 'done',
      summary: 'Price rose from $29/mo to $39/mo.',
      summaryAttempts: 1,
      summaryNextAttemptAt: null,
      summaryError: null,
    });
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]).toMatchObject({ previous: { price: '$29/mo' }, current: { price: '$39/mo' }, changedFields: ['price'] });
  });

  it('never calls the LLM for unchanged or initial snapshots', async () => {
    const summarizer = new FakeSummarizer();
    const { deps, poll, worker } = setup(summarizer);
    await deps.competitors.insert('acme');
    await poll.pollOne('acme'); // initial
    await poll.pollOne('acme'); // v2: changed
    await poll.pollOne('acme'); // v3: changed
    await poll.pollOne('acme'); // v3 again: unchanged
    await worker.tick();
    expect(summarizer.calls).toHaveLength(2);
  });

  it('a failing LLM leaves the snapshot intact and schedules a retry with backoff', async () => {
    const summarizer = new FakeSummarizer().next(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const { deps, poll, worker } = setup(summarizer);
    const pending = await changedSnapshot(deps, poll);

    await worker.tick();

    const after = await deps.snapshots.getById(pending.id);
    expect(after).toMatchObject({
      summaryStatus: 'pending',
      summary: null,
      summaryAttempts: 1,
      summaryError: 'connect ECONNREFUSED',
      price: '$39/mo',
      changed: true,
    });
    expect(after!.summaryNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 1000);

    // Not due yet: another tick does not touch it.
    await worker.tick();
    expect(summarizer.calls).toHaveLength(1);

    // Once due, the retry succeeds.
    await makeDue(pending.id);
    await worker.tick();
    expect(await deps.snapshots.getById(pending.id)).toMatchObject({ summaryStatus: 'done', summary: 'summary', summaryAttempts: 2 });
  });

  it('gives up after LLM_MAX_ATTEMPTS, keeping the snapshot', async () => {
    const summarizer = new FakeSummarizer(async () => {
      throw new Error('upstream timeout');
    });
    const { deps, poll, worker } = setup(summarizer, { LLM_MAX_ATTEMPTS: '2' });
    const pending = await changedSnapshot(deps, poll);

    await worker.tick();
    await makeDue(pending.id);
    await worker.tick();

    const failed = await deps.snapshots.getById(pending.id);
    expect(failed).toMatchObject({ summaryStatus: 'failed', summary: null, summaryAttempts: 2, summaryNextAttemptAt: null, price: '$39/mo' });
    expect(failed!.summaryError).toMatch(/upstream timeout .*max attempts/);
    expect(summarizer.calls).toHaveLength(2);

    await worker.tick();
    expect(summarizer.calls).toHaveLength(2); // failed jobs are never retried
  });

  it('fails immediately on errors that will not go away (4xx)', async () => {
    const summarizer = new FakeSummarizer(async () => {
      throw httpError(401, 'Incorrect API key');
    });
    const { deps, poll, worker } = setup(summarizer);
    const pending = await changedSnapshot(deps, poll);
    await worker.tick();
    expect(await deps.snapshots.getById(pending.id)).toMatchObject({ summaryStatus: 'failed', summaryAttempts: 1 });
    expect((await deps.snapshots.getById(pending.id))!.summaryError).toMatch(/Incorrect API key .*not retryable/);
  });

  it('reaps a job whose last attempt died mid-flight', async () => {
    const summarizer = new FakeSummarizer();
    const { deps, poll, worker } = setup(summarizer, { LLM_MAX_ATTEMPTS: '2' });
    const pending = await changedSnapshot(deps, poll);
    // Simulate: both attempts claimed, process crashed each time, leases expired.
    await t.db.execute(
      sql`UPDATE snapshots SET summary_attempts = 2, summary_next_attempt_at = now() - interval '1 second' WHERE id = ${pending.id}`,
    );
    await worker.tick();
    expect(await deps.snapshots.getById(pending.id)).toMatchObject({ summaryStatus: 'failed', summaryError: 'gave up: all attempts used' });
    expect(summarizer.calls).toHaveLength(0);
  });

  it('fences writes on the attempt number so a stale worker cannot overwrite a newer claim', async () => {
    const { deps, poll } = setup(new FakeSummarizer());
    const pending = await changedSnapshot(deps, poll);

    const [job] = await deps.snapshots.claimPendingSummaries(1, 3, 60_000);
    expect(job).toEqual({ id: pending.id, attempt: 1 });
    expect(await deps.snapshots.claimPendingSummaries(1, 3, 60_000)).toEqual([]); // leased

    expect(await deps.snapshots.completeSummary(pending.id, 0, 'stale')).toBe(false);
    expect(await deps.snapshots.failSummary(pending.id, 0, 'stale', null)).toBe(false);
    expect(await deps.snapshots.completeSummary(pending.id, 1, 'fresh')).toBe(true);
    expect(await deps.snapshots.getById(pending.id)).toMatchObject({ summaryStatus: 'done', summary: 'fresh' });
  });

  it('survives the competitor being removed while the LLM is running', async () => {
    let deps: Deps | undefined;
    const summarizer = new FakeSummarizer(async () => {
      await deps!.competitors.delete('acme');
      return 'too late';
    });
    const s = setup(summarizer);
    deps = s.deps;
    await changedSnapshot(s.deps, s.poll);
    await expect(s.worker.tick()).resolves.toBe(false);
    expect(await s.deps.snapshots.listByCompetitor('acme')).toEqual([]);
  });

  it('processes jobs concurrently up to SUMMARY_CONCURRENCY and drains when more are waiting', async () => {
    const summarizer = new FakeSummarizer();
    const { deps, poll, worker } = setup(summarizer, { SUMMARY_CONCURRENCY: '1' });
    await deps.competitors.insert('acme');
    await poll.pollOne('acme');
    await poll.pollOne('acme');
    await poll.pollOne('acme'); // two changed snapshots pending
    expect(await worker.tick()).toBe(true); // batch full: more may be waiting
    expect(await worker.tick()).toBe(true);
    expect(await worker.tick()).toBe(false);
    expect(summarizer.calls).toHaveLength(2);
  });
});
