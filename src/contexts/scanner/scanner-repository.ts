import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { LlmEvaluationRecord } from "../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { NormalizedMarket, Venue } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import { ScanResult } from "./scanner-result";

export interface ReviewedCandidatePair {
  pair: CandidatePair;
  decision: EquivalenceDecision;
  llmEvaluation?: LlmEvaluationRecord;
}

export interface OrderbookSnapshotArtifact {
  id: string;
  scanRunId: string;
  normalizedMarketId: string;
  venue: Venue;
  venueMarketId: string;
  yesAsk?: number;
  noAsk?: number;
  yesAvailableUsd: number;
  noAvailableUsd: number;
  rawPayload: Record<string, unknown>;
  capturedAt: string;
  stale: boolean;
}

export interface OpportunityWithSourceSnapshots {
  opportunity: CrossVenueOpportunity;
  kalshiOrderbookSnapshotId: string;
  polymarketOrderbookSnapshotId: string;
}

export type SucceededScanResult = ScanResult & { status: "succeeded" };
export type CompletedScanResult = SucceededScanResult & { completedAt: string };

export interface CompletedScanArtifacts {
  scanRun: SucceededScanResult;
  completeScanRun: (scanRun: SucceededScanResult) => CompletedScanResult;
  snapshots: VenueMarketSnapshot[];
  normalizedMarkets: NormalizedMarket[];
  candidatePairs: ReviewedCandidatePair[];
  orderbookSnapshots: OrderbookSnapshotArtifact[];
  opportunities: OpportunityWithSourceSnapshots[];
}

export interface ScannerRepository {
  saveScanRun(scanRun: ScanResult): Promise<void>;
  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<CompletedScanResult>;
}
