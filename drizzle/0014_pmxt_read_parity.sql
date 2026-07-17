-- Issue #96: PMXT-read downstream opportunity parity shadow tables.
-- Stores shadow-only candidates, opportunities, and reason-coded comparisons
-- without touching production candidate_pairs, opportunities, alerts,
-- positions, or execution tables.
CREATE TABLE "pmxt_shadow_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authoritative_scan_run_id" uuid NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"shadow_run_attempt_id" uuid NOT NULL,
	"candidate_pair_id" text NOT NULL,
	"kalshi_market_id" text NOT NULL,
	"polymarket_market_id" text NOT NULL,
	"equivalence_class" text,
	"decision" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_candidates" ADD CONSTRAINT "pmxt_shadow_candidates_authoritative_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("authoritative_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pmxt_shadow_candidates" ADD CONSTRAINT "pmxt_shadow_candidates_shadow_run_attempt_id_pmxt_shadow_run_attempts_id_fk" FOREIGN KEY ("shadow_run_attempt_id") REFERENCES "public"."pmxt_shadow_run_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_candidates_scan_idx" ON "pmxt_shadow_candidates" USING btree ("authoritative_scan_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_candidates_shadow_run_idx" ON "pmxt_shadow_candidates" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_candidates_attempt_idx" ON "pmxt_shadow_candidates" USING btree ("shadow_run_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_candidates_scan_run_pair_unique" ON "pmxt_shadow_candidates" USING btree ("authoritative_scan_run_id", "shadow_run_id", "shadow_run_attempt_id", "candidate_pair_id");--> statement-breakpoint

CREATE TABLE "pmxt_shadow_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authoritative_scan_run_id" uuid NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"shadow_run_attempt_id" uuid NOT NULL,
	"opportunity_id" text NOT NULL,
	"candidate_pair_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_opportunities" ADD CONSTRAINT "pmxt_shadow_opportunities_authoritative_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("authoritative_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pmxt_shadow_opportunities" ADD CONSTRAINT "pmxt_shadow_opportunities_shadow_run_attempt_id_pmxt_shadow_run_attempts_id_fk" FOREIGN KEY ("shadow_run_attempt_id") REFERENCES "public"."pmxt_shadow_run_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_opportunities_scan_idx" ON "pmxt_shadow_opportunities" USING btree ("authoritative_scan_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_opportunities_shadow_run_idx" ON "pmxt_shadow_opportunities" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_opportunities_attempt_idx" ON "pmxt_shadow_opportunities" USING btree ("shadow_run_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_opportunities_scan_run_opp_unique" ON "pmxt_shadow_opportunities" USING btree ("authoritative_scan_run_id", "shadow_run_id", "shadow_run_attempt_id", "opportunity_id");--> statement-breakpoint

CREATE TABLE "pmxt_shadow_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authoritative_scan_run_id" uuid NOT NULL,
	"shadow_run_id" uuid NOT NULL,
	"shadow_run_attempt_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"cause" text NOT NULL,
	"authoritative" jsonb NOT NULL,
	"shadow" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_comparisons" ADD CONSTRAINT "pmxt_shadow_comparisons_authoritative_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("authoritative_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pmxt_shadow_comparisons" ADD CONSTRAINT "pmxt_shadow_comparisons_shadow_run_attempt_id_pmxt_shadow_run_attempts_id_fk" FOREIGN KEY ("shadow_run_attempt_id") REFERENCES "public"."pmxt_shadow_run_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_comparisons_scan_idx" ON "pmxt_shadow_comparisons" USING btree ("authoritative_scan_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_comparisons_shadow_run_idx" ON "pmxt_shadow_comparisons" USING btree ("shadow_run_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_comparisons_attempt_idx" ON "pmxt_shadow_comparisons" USING btree ("shadow_run_attempt_id");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_comparisons_stage_idx" ON "pmxt_shadow_comparisons" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "pmxt_shadow_comparisons_outcome_idx" ON "pmxt_shadow_comparisons" USING btree ("outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_comparisons_scan_run_stage_unique" ON "pmxt_shadow_comparisons" USING btree ("authoritative_scan_run_id", "shadow_run_id", "shadow_run_attempt_id", "stage");
