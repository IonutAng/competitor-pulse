CREATE TABLE "competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "competitors_id_format" CHECK ("competitors"."id" ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"competitor_id" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"price" text NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"previous_snapshot_id" bigint,
	"changed" boolean NOT NULL,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary_status" text NOT NULL,
	"summary" text,
	"summary_attempts" integer DEFAULT 0 NOT NULL,
	"summary_next_attempt_at" timestamp with time zone,
	"summary_error" text,
	CONSTRAINT "snapshots_summary_status" CHECK ("snapshots"."summary_status" IN ('none', 'pending', 'done', 'failed')),
	CONSTRAINT "snapshots_changed_iff_summary" CHECK ("snapshots"."changed" = ("snapshots"."summary_status" <> 'none')),
	CONSTRAINT "snapshots_pending_iff_next_attempt" CHECK (("snapshots"."summary_status" = 'pending') = ("snapshots"."summary_next_attempt_at" IS NOT NULL)),
	CONSTRAINT "snapshots_done_has_summary" CHECK ("snapshots"."summary_status" <> 'done' OR "snapshots"."summary" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_previous_snapshot_id_snapshots_id_fk" FOREIGN KEY ("previous_snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitors_due_idx" ON "competitors" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "snapshots_timeline_idx" ON "snapshots" USING btree ("competitor_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_summary_queue_idx" ON "snapshots" USING btree ("summary_next_attempt_at","id") WHERE "snapshots"."summary_status" = 'pending';