-- Phase 3 #6: persist a separate `first_detected_at` on opportunities.
-- `detected_at` is the current scan's detection timestamp; `first_detected_at`
-- is the wall-clock of the very first time this opportunity was ever seen.
-- On first insert they are equal; on subsequent scans, `first_detected_at`
-- is preserved from the prior row and only `detected_at`/`last_verified_at`
-- advance. This is the source of truth for the immutable "age since first
-- detection" semantics that `opportunity_age_ms` depends on.
ALTER TABLE "opportunities" ADD COLUMN "first_detected_at" timestamp with time zone;--> statement-breakpoint

-- Backfill: existing rows have a single detected_at value; treat that as
-- the first detection timestamp so the column is non-null going forward.
UPDATE "opportunities" SET "first_detected_at" = "detected_at" WHERE "first_detected_at" IS NULL;--> statement-breakpoint

ALTER TABLE "opportunities" ALTER COLUMN "first_detected_at" SET NOT NULL;--> statement-breakpoint

-- `opportunity_age_ms` was previously computed on update as
-- `last_verified_at - detected_at`, which is always zero because
-- `detected_at` advances each scan. Recompute it from the new
-- `first_detected_at` column so the value reflects the immutable
-- age of the opportunity.
UPDATE "opportunities" SET "opportunity_age_ms" = greatest(0, floor(extract(epoch from ("last_verified_at" - "first_detected_at")) * 1000)::integer);
