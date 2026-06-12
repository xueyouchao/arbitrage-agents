-- Phase 4: persisted step state and heartbeat for the resumable worker.
-- `scan_runs.heartbeat_at` is updated on every step transition so the
-- abandoned-scan detector can find scans whose worker died without
-- finalizing.
ALTER TABLE "scan_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint

-- `scan_steps` records every step the resumable orchestrator has
-- attempted. The orchestrator keeps history: a retried step appends
-- a new row with attempt = N+1 rather than overwriting the prior
-- status, so an operator can read the full retry trail from
-- `scan_steps`. The latest row for (scan_run_id, step_name) is the
-- authoritative state; the orchestrator queries it via
-- `MAX(started_at)` and uses a non-unique composite index to keep
-- lookups fast. The non-unique indexes support both the
-- abandoned-detector scans (status_idx) and per-run history (run_idx).
CREATE TABLE "scan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"attempt" integer DEFAULT 1 NOT NULL,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint

ALTER TABLE "scan_steps" ADD CONSTRAINT "scan_steps_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "scan_steps_status_idx" ON "scan_steps" USING btree ("status");--> statement-breakpoint

CREATE INDEX "scan_steps_run_idx" ON "scan_steps" USING btree ("scan_run_id");--> statement-breakpoint

CREATE INDEX "scan_steps_run_name_started_at_idx" ON "scan_steps" USING btree ("scan_run_id","step_name","started_at" DESC);
