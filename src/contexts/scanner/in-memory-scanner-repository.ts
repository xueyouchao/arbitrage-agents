import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import {
  CompletedScanArtifacts,
  CompletedScanResult,
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
    const index = this.scanRuns.findIndex((existing) => existing.id === scanRun.id);
    if (index === -1) {
      this.scanRuns.push(scanRun);
    } else {
      this.scanRuns[index] = scanRun;
    }
    return Promise.resolve();
  }

  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<CompletedScanResult> {
    const completedScanRun = artifacts.completeScanRun(artifacts.scanRun);
    this.snapshots.push(...artifacts.snapshots);
    this.normalizedMarkets.push(...artifacts.normalizedMarkets.map((review) => review.market));
    this.candidatePairs.push(...artifacts.candidatePairs);
    this.orderbookSnapshots.push(...artifacts.orderbookSnapshots);
    this.opportunities.push(...artifacts.opportunities);
    this.scanRuns.push(completedScanRun);
    return Promise.resolve(completedScanRun);
  }
}
