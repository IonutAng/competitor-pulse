import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, testDeps } from '../helpers/app.js';
import { setupTestDb, type TestDb } from '../helpers/db.js';

describe('app plumbing', () => {
  let t: TestDb;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    t = await setupTestDb();
    const staticDir = mkdtempSync(join(tmpdir(), 'competitor-pulse-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>spa</title>');
    app = buildTestApp(testDeps(t, { STATIC_DIR: staticDir }));
    app.get('/api/boom', () => {
      throw new Error('kaboom');
    });
    await app.ready();
  });
  beforeEach(() => t.reset());
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("maps Fastify's own client errors to stable codes", async () => {
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: { code: 'invalid_json' } });

    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/xml' },
      payload: '<id>acme-crm</id>',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  it('accepts a body-less POST that still carries a JSON content-type', async () => {
    const poll = await app.inject({
      method: 'POST',
      url: '/api/competitors/ghost/poll',
      headers: { 'content-type': 'application/json' },
    });
    expect(poll.statusCode).toBe(404); // reached the handler; not rejected by the parser
    expect(poll.json()).toMatchObject({ error: { code: 'not_found' } });

    const create = await app.inject({
      method: 'POST',
      url: '/api/competitors',
      headers: { 'content-type': 'application/json' },
    });
    expect(create.statusCode).toBe(400); // the schema, not the parser, says a body was required
    expect(create.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answers 500s with a generic message and the request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error', requestId: expect.any(String) as string },
    });
  });

  it('forbids caching of API responses and sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/competitors' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('serves the SPA for unknown non-API GETs only, judged on the decoded path', async () => {
    const deepLink = await app.inject({ method: 'GET', url: '/competitors/acme-crm' });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers['content-type']).toContain('text/html');
    expect(deepLink.headers['cache-control']).not.toBe('no-store');

    for (const url of ['/api/nope', '/%61pi/nope', '/api']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ error: { code: 'not_found' } });
    }
    const post = await app.inject({ method: 'POST', url: '/competitors/acme-crm' });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('publishes an OpenAPI document and the interactive docs', async () => {
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    const doc = spec.json<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/competitors',
        '/api/competitors/{id}/snapshots',
        '/api/snapshots/{id}/retry-summary',
      ]),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Competitor', 'Snapshot', 'Error']),
    );

    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
  });
});
