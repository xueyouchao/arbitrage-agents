export type ScanFailureCategory = "fetch" | "processing" | "persistence" | "abandoned";

export interface ScanMetrics {
  marketsScanned: number;
  normalizedMarkets: number;
  candidatePairs: number;
  opportunitiesFound: number;
  llmEvaluations: number;
  llmEvaluationsSkipped?: number;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  llmEstimatedCostUsd?: number;
  llmLatencyMs?: number;
  failureCategory?: ScanFailureCategory;
  failureReason?: string;
}

export interface ScanResult {
  id: string;
  // `abandoned` is a Phase 4 terminal status emitted by the
  // AbandonedScanDetector. It marks a scan whose worker died before
  // finalize; the next worker iteration re-queues it.
  status: "running" | "succeeded" | "failed" | "abandoned";
  startedAt: string;
  completedAt?: string;
  metrics: ScanMetrics;
  failureCategory?: ScanFailureCategory;
  failureReason?: string;
  // Phase 4 Finding #6: per-worker lease. The worker stamps its own
  // `workerId` on every scan it creates so the abandoned-scan detector
  // can skip runs owned by the active worker process. Without this,
  // a long-running scan (>abandonedAfterMs) is falsely flagged as
  // abandoned by the next worker iteration.
  workerId?: string;
}
