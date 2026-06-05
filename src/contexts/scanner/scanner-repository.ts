import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import { ScanResult } from "./scanner-result";

export interface ReviewedCandidatePair {
  pair: CandidatePair;
  decision: EquivalenceDecision;
}

export interface CompletedScanArtifacts {
  scanRun: ScanResult & { status: "succeeded" };
  snapshots: VenueMarketSnapshot[];
  normalizedMarkets: NormalizedMarket[];
  candidatePairs: ReviewedCandidatePair[];
  opportunities: CrossVenueOpportunity[];
}

export interface ScannerRepository {
  saveScanRun(scanRun: ScanResult): Promise<void>;
  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<void>;
}
