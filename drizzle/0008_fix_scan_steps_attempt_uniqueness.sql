-- Defensively remove any rows that would violate the upcoming unique index on
-- (scan_run_id, step_name, attempt). The orchestrator treats the latest row
-- per step as authoritative, so within each (scan_run_id, step_name, attempt)
-- group we keep the row with the latest started_at (and id as a deterministic
-- tie-breaker) and delete the rest. This makes the migration safe to run on
-- deployments that already have scan_steps rows.
DELETE FROM "scan_steps"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "scan_run_id", "step_name", "attempt"
        ORDER BY "started_at" DESC, "id" DESC
      ) AS rn
    FROM "scan_steps"
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- The unique index is intentionally built inside the migration transaction
-- rather than with CONCURRENTLY. drizzle-orm wraps each pending migration in
-- a single transaction, and PostgreSQL does not allow CREATE INDEX CONCURRENTLY
-- inside a transaction block. scan_steps is expected to remain small, so the
-- brief lock is acceptable. For large production tables, consider applying this
-- migration during a maintenance window or running the index build manually with
-- CONCURRENTLY outside the standard migration flow.
CREATE UNIQUE INDEX "scan_steps_run_name_attempt_unique" ON "scan_steps" USING btree ("scan_run_id","step_name","attempt");