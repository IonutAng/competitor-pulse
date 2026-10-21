import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { CompetitorRow } from '../db/schema.js';
import { HttpError } from '../http-error.js';

// Mirrors the CHECK constraint on competitors.id.
export const COMPETITOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const newCompetitorBody = z.object({
  id: z
    .string()
    .regex(
      COMPETITOR_ID_PATTERN,
      'id must be a lowercase slug such as "acme-crm" (letters, digits, hyphens; max 63 chars)',
    ),
});

// Lookups by id do not validate the format: an id that cannot exist is simply not found.
export const idParams = z.object({ id: z.string().min(1) });

export function toCompetitorDto(row: CompetitorRow) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}
export type CompetitorDto = ReturnType<typeof toCompetitorDto>;

export const competitorRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { competitors, source }) => {
  app.get('/api/competitors', async () => {
    const rows = await competitors.list();
    return rows.map(toCompetitorDto);
  });

  app.post('/api/competitors', { schema: { body: newCompetitorBody } }, async (request, reply) => {
    const row = await competitors.insert(request.body.id);
    if (!row) {
      throw new HttpError(409, 'already_tracked', `Competitor "${request.body.id}" is already tracked`);
    }
    return reply.status(201).send(toCompetitorDto(row));
  });

  app.delete('/api/competitors/:id', { schema: { params: idParams } }, async (request, reply) => {
    const deleted = await competitors.delete(request.params.id);
    if (!deleted) {
      throw new HttpError(404, 'not_found', `Competitor "${request.params.id}" is not tracked`);
    }
    source.forget?.(request.params.id);
    return reply.status(204).send();
  });
};
