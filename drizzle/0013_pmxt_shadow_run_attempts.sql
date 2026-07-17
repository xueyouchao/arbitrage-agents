-- Issue #93: PMXT shadow evaluation lease table. Records every claim of an
-- authoritative scan run by the shadow runner. The (authoritative_scan_run_id,
-- attempt_number) unique index makes concurrent claims converge safely; the
-- lease expiry allows a new worker to retry a failed or timed-out shadow run
-- while preserving full attempt history.
CREATE TABLE "pmxt_shadow_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"authoritative_scan_run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone NOT NULL,
	"worker_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"retry_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_run_attempts" ADD CONSTRAINT "pmxt_shadow_run_attempts_authoritative_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("authoritative_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_attempts_scan_idx" ON "pmxt_shadow_run_attempts" USING btree ("authoritative_scan_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_attempts_worker_idx" ON "pmxt_shadow_run_attempts" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_attempts_leased_until_idx" ON "pmxt_shadow_run_attempts" USING btree ("leased_until");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_attempts_scan_attempt_unique" ON "pmxt_shadow_run_attempts" USING btree ("authoritative_scan_run_id", "attempt_number");
