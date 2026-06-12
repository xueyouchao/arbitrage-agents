// Phase 4: scan step primitives.
//
// The resumable worker treats a scan as a sequence of named steps. Each
// step transition is persisted to `scan_steps` via `ScanStepRepository`,
// which doubles as a checkpoint log: the orchestrator re-runs a step only
// when its latest row is not `succeeded`. Steps are idempotent: re-saving
// the same succeeded step is a no-op because the underlying upsert key
// is `(scan_run_id, step_name)`.

export const RESUMABLE_SCAN_STEP_NAMES = [
  "fetch_markets",
  "fetch_books",
  "normalize_markets",
  "review_pairs",
  "calculate_opportunities",
  "finalize"
] as const;

export type ScanStepName = (typeof RESUMABLE_SCAN_STEP_NAMES)[number];

export const SCAN_STEP_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type ScanStepStatus = (typeof SCAN_STEP_STATUSES)[number];

// One persisted step row. `metadata` is the only field free of a fixed
// shape: the orchestrator uses it to carry rehydration hints, idempotency
// keys, or last-retry context. All other fields round-trip directly to
// the `scan_steps` table.
export interface ScanStepArtifact {
  scanRunId: string;
  stepName: ScanStepName;
  status: ScanStepStatus;
  startedAt: string;
  completedAt?: string;
  attempt?: number;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}

export interface ScanStepRow extends ScanStepArtifact {
  id: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

export interface ScanStepRepository {
  saveStep(step: ScanStepArtifact): Promise<ScanStepRow>;
  listForRun(scanRunId: string): ScanStepRow[];
  getStep(scanRunId: string, stepName: ScanStepName): ScanStepRow | undefined;
  markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void>;
}
