import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/deps.js';
import { FixtureListingSource } from '../../src/source/fixture-source.js';
import { PollWorker } from '../../src/workers/poll-worker.js';
import { buildTestApp, testDeps } from '../helpers/app.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';
import { v1, v2, v3 } from '../helpers/listings.js';

describe('snapshots API', () => {
  let t: TestDb;
  let deps: Deps;
  let app: ReturnType<typeof buildTestApp>;
  let source: FixtureListingSource;

  beforeAll(async () => {
    t = await setupTestDb();
    source = new FixtureListingSource(new Map([['acme-crm', [v1, v2, v3]]]));
    deps = testDeps(t.db, {}, { source });
    app = buildTestApp(deps);
    await app.ready();
  });
  beforeEach(async () => {
    await t.reset();
    source.forget('acme-crm');
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  async function pollTimes(n: number) {
    const worker = new PollWorker(deps, app.log);
    for (let i = 0; i < n; i++) await worker.pollOne('acme-crm');
  }

  it('answers 404 for a competitor that is not tracked', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/competitors/ghost/snapshots' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns the history newest first in the contract shape', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    await pollTimes(3);

    const res = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(3);
    expect(body.map((s: { price: string }) => s.price)).toEqual(['$39/mo', '$39/mo', '$29/mo']);

    const [newest, , oldest] = body;
    expect(newest).toMatchObject({
      title: v3.title,
      tagline: v3.tagline,
      price: v3.price,
      description: v3.description,
      changed: true,
      summary: null, // pending, not produced yet
      isInitial: false,
      previousSnapshotId: body[1].id,
      changedFields: ['tagline', 'description'],
      summaryStatus: 'pending',
    });
    expect(newest.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(oldest).toMatchObject({
      changed: false,
      summary: null,
      isInitial: true,
      previousSnapshotId: null,
      summaryStatus: 'none',
    });
  });

  it('paginates with ?limit and the ?before keyset cursor', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    await pollTimes(3);

    const page1 = (await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots?limit=2' })).json();
    expect(page1).toHaveLength(2);
    const page2 = (
      await app.inject({ method: 'GET', url: `/api/competitors/acme-crm/snapshots?limit=2&before=${page1[1].id}` })
    ).json();
    expect(page2).toHaveLength(1);
    expect(page2[0].isInitial).toBe(true);

    const bad = await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots?limit=0' });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /poll schedules an immediate poll (202) and answers 404 for unknown ids', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    const res = await app.inject({ method: 'POST', url: '/api/competitors/acme-crm/poll' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: 'acme-crm' });
    expect(res.json().nextPollAt).toMatch(/Z$/);

    const missing = await app.inject({ method: 'POST', url: '/api/competitors/ghost/poll' });
    expect(missing.statusCode).toBe(404);
  });

  it('removing a competitor removes its history and resets the stub sequence', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    await pollTimes(3);
    expect((await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' })).statusCode).toBe(204);

    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    await pollTimes(1);
    const body = (await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' })).json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ price: v1.price, isInitial: true });
  });

  it('POST /api/snapshots/:id/retry-summary re-queues a failed summary only', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    await pollTimes(2);
    const [changed] = (await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' })).json();
    expect(changed.summaryStatus).toBe('pending');

    const notFailed = await app.inject({ method: 'POST', url: `/api/snapshots/${changed.id}/retry-summary` });
    expect(notFailed.statusCode).toBe(409);

    await t.db.execute(
      sql`UPDATE snapshots SET summary_status = 'failed', summary_next_attempt_at = NULL, summary_attempts = 3, summary_error = 'boom' WHERE id = ${changed.id}`,
    );
    const retried = await app.inject({ method: 'POST', url: `/api/snapshots/${changed.id}/retry-summary` });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toEqual({ id: changed.id, summaryStatus: 'pending' });
    const [after] = (await app.inject({ method: 'GET', url: '/api/competitors/acme-crm/snapshots' })).json();
    expect(after).toMatchObject({ summaryStatus: 'pending', summaryError: null });

    expect((await app.inject({ method: 'POST', url: '/api/snapshots/999999/retry-summary' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/snapshots/abc/retry-summary' })).statusCode).toBe(400);
  });
});
