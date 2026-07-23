-- Issue #93 follow-up: lease fairness and retry policy.
-- Adds next_retry_at for deterministic backoff and max_attempts to prevent
-- infinite retry loops that starve subsequent scans. Exhausted attempts are
-- terminal and never reclaimed.
ALTER TABLE "pmxt_shadow_run_attempts" ADD COLUMN "next_retry_at" timestamp with time zone;
ALTER TABLE "pmxt_shadow_run_attempts" ADD COLUMN "max_attempts" integer NOT NULL DEFAULT 5;
CREATE INDEX "pmxt_shadow_run_attempts_next_retry_at_idx" ON "pmxt_shadow_run_attempts" ("next_retry_at");
