import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CompetitorDto } from '../../src/routes/schemas.js';
import { buildTestApp, testDeps } from '../helpers/app.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';

describe('competitors API', () => {
  let t: TestDb;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    t = await setupTestDb();
    app = buildTestApp(testDeps(t));
    await app.ready();
  });
  beforeEach(() => t.reset());
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('adds, lists and removes a competitor (the contract)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      payload: { id: 'acme-crm' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe('/api/competitors/acme-crm');
    expect(created.json()).toMatchObject({ id: 'acme-crm', lastPolledAt: null, lastError: null });
    expect(created.json<CompetitorDto>().createdAt).toMatch(/Z$/);

    const one = await app.inject({ method: 'GET', url: created.headers.location as string });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(created.json());

    const listed = await app.inject({ method: 'GET', url: '/api/competitors' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject([{ id: 'acme-crm' }]);

    const removed = await app.inject({ method: 'DELETE', url: '/api/competitors/acme-crm' });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');

    const after = await app.inject({ method: 'GET', url: '/api/competitors' });
    expect(after.json()).toEqual([]);
  });

  it('lists competitors in the order they were added', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'north-analytics' } });
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    const listed = await app.inject({ method: 'GET', url: '/api/competitors' });
    expect(listed.json<CompetitorDto[]>().map((c) => c.id)).toEqual(['north-analytics', 'acme-crm']);
  });

  it('answers 409 when the competitor is already tracked', async () => {
    await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    const again = await app.inject({ method: 'POST', url: '/api/competitors', payload: { id: 'acme-crm' } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'already_tracked' } });
  });

  it('answers 400 for malformed ids and bodies', async () => {
    for (const payload of [{ id: 'Acme CRM' }, { id: '' }, { id: '-leading-hyphen' }, {}, { id: 42 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/competitors', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    const notJson = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json()).toMatchObject({ error: { code: 'invalid_json' } });
  });

  it('answers 404 for competitors that are not tracked, however the id looks', async () => {
    for (const id of ['ghost', 'Not A Slug']) {
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/competitors/${encodeURIComponent(id)}`,
      });
      expect(removed.statusCode, id).toBe(404);
      expect(removed.json()).toMatchObject({ error: { code: 'not_found' } });
      const fetched = await app.inject({ method: 'GET', url: `/api/competitors/${encodeURIComponent(id)}` });
      expect(fetched.statusCode, id).toBe(404);
    }
  });
});
