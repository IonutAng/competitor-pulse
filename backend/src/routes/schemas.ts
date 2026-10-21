import { z } from 'zod';
import { LISTING_FIELDS, SUMMARY_STATUSES } from '../db/schema.js';

// Response schemas: the single source of truth for the wire format. Routes serialize through
// them (undeclared fields are dropped), /docs is generated from them, and the tests type
// responses with them.

export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string().describe('Stable identifier, e.g. invalid_request, not_found, already_tracked'),
      message: z.string(),
      requestId: z.string().optional().describe('Present on 5xx; matches the server log line'),
      issues: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional()
        .describe('Present on invalid_request'),
    }),
  })
  .meta({ id: 'Error' });

export const competitorSchema = z
  .object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    lastPolledAt: z.iso.datetime().nullable().describe('Last poll attempt; null until the first one'),
    lastError: z.string().nullable().describe('Why the last fetch failed; null after a successful poll'),
  })
  .meta({ id: 'Competitor' });

export const snapshotSchema = z
  .object({
    id: z.int().positive().describe('Ordering key of the timeline; also the keyset cursor'),
    fetchedAt: z.iso.datetime(),
    title: z.string(),
    tagline: z.string(),
    price: z.string(),
    description: z.string(),
    changed: z.boolean().describe('false if identical to the previous snapshot'),
    summary: z.string().nullable().describe('AI summary; null if unchanged, pending or failed'),
    isInitial: z.boolean().describe("The competitor's first snapshot: nothing to compare against"),
    previousSnapshotId: z.int().nullable().describe('The snapshot this one was diffed against'),
    changedFields: z.array(z.enum(LISTING_FIELDS)),
    summaryStatus: z.enum(SUMMARY_STATUSES),
    summaryError: z.string().nullable(),
  })
  .meta({ id: 'Snapshot' });

export const pollAcceptedSchema = z
  .object({ id: z.string(), nextPollAt: z.iso.datetime() })
  .meta({ id: 'PollAccepted' });

export const retryAcceptedSchema = z
  .object({ id: z.int(), summaryStatus: z.enum(SUMMARY_STATUSES) })
  .meta({ id: 'RetryAccepted' });

export const healthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    db: z.enum(['ok', 'error']),
    pool: z.object({ total: z.int(), idle: z.int(), waiting: z.int() }),
    workersEnabled: z.boolean(),
    workers: z.array(
      z.object({
        name: z.string(),
        running: z.boolean(),
        lastTickAt: z.iso.datetime().nullable(),
        lastSuccessAt: z.iso.datetime().nullable(),
        consecutiveFailures: z.int(),
        lastError: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'Health' });

export type CompetitorDto = z.infer<typeof competitorSchema>;
export type SnapshotDto = z.infer<typeof snapshotSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
