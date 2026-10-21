import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SnapshotRow } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { HttpError } from '../http-error.js';
import { idParams } from './competitors.js';
import {
  errorEnvelopeSchema,
  pollAcceptedSchema,
  retryAcceptedSchema,
  snapshotSchema,
  type SnapshotDto,
} from './schemas.js';

const listQuery = z.object({
  // Bounded even when omitted: the UI pages 50 at a time, and a history grows forever.
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  before: z.coerce.number().int().positive().optional(),
});

const snapshotIdParams = z.object({ id: z.coerce.number().int().positive() });

/** The contract's Snapshot shape plus the extras the UI uses; see schemas.ts for the wire format. */
export function toSnapshotDto(row: SnapshotRow): SnapshotDto {
  return {
    id: row.id,
    fetchedAt: row.fetchedAt.toISOString(),
    title: row.title,
    tagline: row.tagline,
    price: row.price,
    description: row.description,
    changed: row.changed,
    // Contract: null unless a summary was produced (unchanged, pending and failed all read as null).
    summary: row.summaryStatus === 'done' ? row.summary : null,
    isInitial: row.previousSnapshotId === null,
    previousSnapshotId: row.previousSnapshotId,
    changedFields: row.changedFields,
    summaryStatus: row.summaryStatus,
    summaryError: row.summaryError,
  };
}

export const snapshotRoutes: FastifyPluginAsyncZod<Deps> = async (app, { competitors, snapshots }) => {
  app.get(
    '/api/competitors/:id/snapshots',
    {
      schema: {
        tags: ['snapshots'],
        summary: "A competitor's history, newest first",
        description:
          "Keyset pagination: more pages exist iff the response holds `limit` items; pass the last item's `id` as `before`.",
        params: idParams,
        querystring: listQuery,
        response: { 200: z.array(snapshotSchema), 404: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const { id } = request.params;
      if (!(await competitors.get(id))) {
        throw new HttpError(404, 'not_found', `Competitor "${id}" is not tracked`);
      }
      const rows = await snapshots.listByCompetitor(id, request.query);
      return rows.map(toSnapshotDto);
    },
  );

  app.get(
    '/api/snapshots/:id',
    {
      schema: {
        tags: ['snapshots'],
        summary: 'One snapshot',
        params: snapshotIdParams,
        response: { 200: snapshotSchema, 404: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const row = await snapshots.getById(request.params.id);
      if (!row) throw new HttpError(404, 'not_found', `Snapshot ${request.params.id} not found`);
      return toSnapshotDto(row);
    },
  );

  app.post(
    '/api/competitors/:id/poll',
    {
      schema: {
        tags: ['competitors'],
        summary: 'Poll now',
        description: 'Makes the competitor due immediately; the poll worker picks it up on its next tick.',
        params: idParams,
        response: { 202: pollAcceptedSchema, 404: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const nextPollAt = await competitors.requestPoll(id);
      if (!nextPollAt) throw new HttpError(404, 'not_found', `Competitor "${id}" is not tracked`);
      return reply.status(202).send({ id, nextPollAt: nextPollAt.toISOString() });
    },
  );

  app.post(
    '/api/snapshots/:id/retry-summary',
    {
      schema: {
        tags: ['snapshots'],
        summary: 'Re-queue a failed summary',
        description:
          'The recovery path after an LLM outage longer than the retry budget. Idempotent: a summary that is already pending answers 202 too; one that is done or not applicable answers 409.',
        params: snapshotIdParams,
        response: { 202: retryAcceptedSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await snapshots.retrySummary(id))) {
        const snapshot = await snapshots.getById(id);
        if (!snapshot) throw new HttpError(404, 'not_found', `Snapshot ${id} not found`);
        if (snapshot.summaryStatus !== 'pending') {
          throw new HttpError(
            409,
            'invalid_state',
            `Snapshot ${id} has no failed summary to retry (status: ${snapshot.summaryStatus})`,
          );
        }
        // Already queued (a double click, or a client retrying a dropped response): same end state.
      }
      return reply.status(202).send({ id, summaryStatus: 'pending' });
    },
  );
};
