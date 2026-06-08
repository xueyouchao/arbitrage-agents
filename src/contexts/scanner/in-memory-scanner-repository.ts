import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import {
  CompletedScanArtifacts,
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair,
  ScannerRepository
} from "./scanner-repository";
import { ScanResult } from "./scanner-result";

export class InMemoryScannerRepository implements ScannerRepository {
  readonly scanRuns: ScanResult[] = [];
  readonly snapshots: VenueMarketSnapshot[] = [];
  readonly normalizedMarkets: NormalizedMarket[] = [];
  readonly candidatePairs: ReviewedCandidatePair[] = [];
  readonly orderbookSnapshots: OrderbookSnapshotArtifact[] = [];
  readonly opportunities: OpportunityWithSourceSnapshots[] = [];

  saveScanRun(scanRun: ScanResult): Promise<void> {
    this.scanRuns.push(scanRun);
    return Promise.resolve();
  }

  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<void> {
    this.snapshots.push(...artifacts.snapshots);
    this.normalizedMarkets.push(...artifacts.normalizedMarkets);
    this.candidatePairs.push(...artifacts.candidatePairs);
    this.orderbookSnapshots.push(...artifacts.orderbookSnapshots);
    this.opportunities.push(...artifacts.opportunities);
    this.scanRuns.push(artifacts.scanRun);
    return Promise.resolve();
  }
}
