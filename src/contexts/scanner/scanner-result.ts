export type ScanFailureCategory = "fetch" | "processing" | "persistence";

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
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  metrics: ScanMetrics;
  failureCategory?: ScanFailureCategory;
  failureReason?: string;
}
