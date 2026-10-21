import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const LISTING_FIELDS = ['title', 'tagline', 'price', 'description'] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

export const SUMMARY_STATUSES = ['none', 'pending', 'done', 'failed'] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

export const competitors = pgTable(
  'competitors',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Scheduling state: a competitor is due when next_poll_at <= now(). Defaults to "now" so a
    // freshly added competitor is polled on the next scheduler tick.
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    // Last fetch error, cleared by the next successful poll.
    lastError: text('last_error'),
  },
  (t) => [
    index('competitors_due_idx').on(t.nextPollAt),
    check('competitors_id_format', sql`${t.id} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
  ],
);

export const snapshots = pgTable(
  'snapshots',
  {
    // `id` is the linearization order of a competitor's history; the timeline sorts by it.
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    competitorId: text('competitor_id')
      .notNull()
      .references(() => competitors.id, { onDelete: 'cascade' }),
    // clock_timestamp() (not now()) so the value is taken when the row is written, after the
    // per-competitor lock, and therefore increases with `id`.
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    title: text('title').notNull(),
    tagline: text('tagline').notNull(),
    price: text('price').notNull(),
    description: text('description').notNull(),

    contentHash: text('content_hash').notNull(),
    // NULL only for the first snapshot of a competitor.
    previousSnapshotId: bigint('previous_snapshot_id', { mode: 'number' }).references(
      (): AnyPgColumn => snapshots.id,
    ),
    changed: boolean('changed').notNull(),
    changedFields: text('changed_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`)
      .$type<ListingField[]>(),

    // Summary state machine: none (unchanged) | pending | done | failed.
    summaryStatus: text('summary_status').notNull().$type<SummaryStatus>(),
    summary: text('summary'),
    summaryAttempts: integer('summary_attempts').notNull().default(0),
    // While pending: when the job may next be claimed (also acts as the lease while running).
    summaryNextAttemptAt: timestamp('summary_next_attempt_at', { withTimezone: true }),
    summaryError: text('summary_error'),
  },
  (t) => [
    index('snapshots_timeline_idx').on(t.competitorId, t.id.desc()),
    index('snapshots_summary_queue_idx')
      .on(t.summaryNextAttemptAt, t.id)
      .where(sql`${t.summaryStatus} = 'pending'`),
    check('snapshots_summary_status', sql`${t.summaryStatus} IN ('none', 'pending', 'done', 'failed')`),
    check('snapshots_changed_iff_summary', sql`${t.changed} = (${t.summaryStatus} <> 'none')`),
    check(
      'snapshots_pending_iff_next_attempt',
      sql`(${t.summaryStatus} = 'pending') = (${t.summaryNextAttemptAt} IS NOT NULL)`,
    ),
    check('snapshots_done_has_summary', sql`${t.summaryStatus} <> 'done' OR ${t.summary} IS NOT NULL`),
  ],
);

export type CompetitorRow = typeof competitors.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
