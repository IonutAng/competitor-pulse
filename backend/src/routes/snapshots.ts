import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { SnapshotRow } from '../db/schema.js';
import { HttpError } from '../http-error.js';
import { idParams } from './competitors.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.coerce.number().int().positive().optional(),
});

/** The contract's Snapshot shape plus a few extras the UI uses (id, isInitial, changedFields, summaryStatus, summaryError). */
export function toSnapshotDto(row: SnapshotRow) {
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
    changedFields: row.changedFields,
    summaryStatus: row.summaryStatus,
    summaryError: row.summaryError,
  };
}

export const snapshotRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { competitors, snapshots }) => {
  app.get(
    '/api/competitors/:id/snapshots',
    { schema: { params: idParams, querystring: listQuery } },
    async (request) => {
      const { id } = request.params;
      if (!(await competitors.get(id))) {
        throw new HttpError(404, 'not_found', `Competitor "${id}" is not tracked`);
      }
      const rows = await snapshots.listByCompetitor(id, request.query);
      return rows.map(toSnapshotDto);
    },
  );

  // "Poll now": makes the competitor due; the poll worker picks it up on its next tick.
  app.post('/api/competitors/:id/poll', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params;
    const nextPollAt = await competitors.requestPoll(id);
    if (!nextPollAt) {
      throw new HttpError(404, 'not_found', `Competitor "${id}" is not tracked`);
    }
    return reply.status(202).send({ id, nextPollAt: nextPollAt.toISOString() });
  });
};
