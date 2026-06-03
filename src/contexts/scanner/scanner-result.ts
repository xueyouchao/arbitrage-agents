export interface ScanMetrics {
  marketsScanned: number;
  normalizedMarkets: number;
  candidatePairs: number;
  opportunitiesFound: number;
  llmEvaluations: number;
}

export interface ScanResult {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  metrics: ScanMetrics;
}
