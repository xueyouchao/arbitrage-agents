import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { CandidatePair } from "../matching/domain/candidate-pair";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import { ScanResult } from "./scanner-result";

export interface ScannerRepository {
  saveScanRun(scanRun: ScanResult): Promise<void>;
  saveSnapshots(snapshots: VenueMarketSnapshot[]): Promise<void>;
  saveNormalizedMarkets(markets: NormalizedMarket[]): Promise<void>;
  saveCandidatePairs(pairs: CandidatePair[]): Promise<void>;
  saveOpportunities(opportunities: CrossVenueOpportunity[]): Promise<void>;
}

export class InMemoryScannerRepository implements ScannerRepository {
  readonly scanRuns: ScanResult[] = [];
  readonly snapshots: VenueMarketSnapshot[] = [];
  readonly normalizedMarkets: NormalizedMarket[] = [];
  readonly candidatePairs: CandidatePair[] = [];
  readonly opportunities: CrossVenueOpportunity[] = [];
  activeScanRunId?: string;

  saveScanRun(scanRun: ScanResult): Promise<void> {
    this.activeScanRunId = scanRun.id;
    this.scanRuns.push(scanRun);
    return Promise.resolve();
  }

  saveSnapshots(snapshots: VenueMarketSnapshot[]): Promise<void> {
    this.snapshots.push(...snapshots);
    return Promise.resolve();
  }

  saveNormalizedMarkets(markets: NormalizedMarket[]): Promise<void> {
    this.normalizedMarkets.push(...markets);
    return Promise.resolve();
  }

  saveCandidatePairs(pairs: CandidatePair[]): Promise<void> {
    this.candidatePairs.push(...pairs);
    return Promise.resolve();
  }

  saveOpportunities(opportunities: CrossVenueOpportunity[]): Promise<void> {
    this.opportunities.push(...opportunities);
    return Promise.resolve();
  }
}
