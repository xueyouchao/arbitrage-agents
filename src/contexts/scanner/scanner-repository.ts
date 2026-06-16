import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { PaperTradeSimulation } from "../arbitrage/domain/paper-trade-simulator";
import { LlmEvaluationRecord } from "../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { NormalizedMarket, Venue } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import { ScanResult } from "./scanner-result";

export interface ReviewedNormalizedMarket {
  market: NormalizedMarket;
  llmEvaluation?: LlmEvaluationRecord;
}

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
  normalizedMarkets: ReviewedNormalizedMarket[];
  candidatePairs: ReviewedCandidatePair[];
  orderbookSnapshots: OrderbookSnapshotArtifact[];
  opportunities: OpportunityWithSourceSnapshots[];
  // Phase 3 #6: paper-trade simulations produced for each emitted
  // opportunity. Empty when the simulator is disabled or every call
  // degraded to a no-op. Persisted alongside the opportunity so an
  // operator can compare apparent edge (the canonical netEdge) to
  // actionable edge (the simulator's netEdge after partial fills and
  // adverse selection).
  paperTradeSimulations: PaperTradeSimulation[];
}

export interface ScannerRepository {
  saveScanRun(scanRun: ScanResult): Promise<void>;
  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<CompletedScanResult>;
  // Phase 4: the abandoned-scan detector iterates running scan runs
  // without re-fetching the world. The repository returns a snapshot
  // (defensive copy) so the detector can compute heartbeats safely
  // while the worker mutates other state. Async so the Postgres adapter
  // can perform a real query; the in-memory adapter returns synchronously
  // wrapped in Promise.resolve.
  listScanRuns(): Promise<readonly ScanResult[]>;
}
