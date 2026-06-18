-- Phase 4 Finding #6: per-worker lease. The worker stamps its own UUID
-- on every scan it creates so the abandoned-scan detector can skip runs
-- owned by the active worker process. NULL for legacy scans (treated as
-- abandoned by the detector for backward compatibility).
ALTER TABLE "scan_runs" ADD COLUMN "worker_id" text;