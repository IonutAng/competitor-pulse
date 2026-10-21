import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { CompetitorRow } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../http-error.js';
import { competitorSchema, errorEnvelopeSchema, type CompetitorDto } from './schemas.js';

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

// String ids are not format-checked on lookups: a slug that could never be valid is simply
// "not tracked" (404). Numeric ids (snapshots) have a parse step, so a non-number there is a 400.
export const idParams = z.object({ id: z.string().min(1) });

export function toCompetitorDto(row: CompetitorRow): CompetitorDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

const notTracked = (id: string) => new HttpError(404, 'not_found', `Competitor "${id}" is not tracked`);

export const competitorRoutes: FastifyPluginAsyncZod<Deps> = async (app, { competitors, source }) => {
  app.get(
    '/api/competitors',
    {
      schema: {
        tags: ['competitors'],
        summary: 'List tracked competitors',
        response: { 200: z.array(competitorSchema) },
      },
    },
    async () => (await competitors.list()).map(toCompetitorDto),
  );

  app.get(
    '/api/competitors/:id',
    {
      schema: {
        tags: ['competitors'],
        summary: 'One tracked competitor',
        params: idParams,
        response: { 200: competitorSchema, 404: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const row = await competitors.get(request.params.id);
      if (!row) throw notTracked(request.params.id);
      return toCompetitorDto(row);
    },
  );

  app.post(
    '/api/competitors',
    {
      schema: {
        tags: ['competitors'],
        summary: 'Track a competitor',
        description: 'The first poll runs within a scheduler tick. Adding an id twice answers 409.',
        body: newCompetitorBody,
        response: { 201: competitorSchema, 400: errorEnvelopeSchema, 409: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const row = await competitors.insert(request.body.id);
      if (!row) {
        throw new HttpError(409, 'already_tracked', `Competitor "${request.body.id}" is already tracked`);
      }
      return reply
        .status(201)
        .header('location', `/api/competitors/${encodeURIComponent(row.id)}`)
        .send(toCompetitorDto(row));
    },
  );

  app.delete(
    '/api/competitors/:id',
    {
      schema: {
        tags: ['competitors'],
        summary: 'Stop tracking a competitor (deletes its history)',
        description: 'Answers 204 with no body, or 404 if the competitor is not tracked.',
        params: idParams,
      },
    },
    async (request, reply) => {
      const deleted = await competitors.delete(request.params.id);
      if (!deleted) throw notTracked(request.params.id);
      source.forget?.(request.params.id);
      return reply.status(204).send();
    },
  );
};
