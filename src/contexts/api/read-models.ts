import { Inject, Injectable } from "@nestjs/common";
import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { NormalizedMarket } from "../matching/domain/normalized-market";

export interface ScanRunReadModel {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  marketsScanned: number;
  opportunitiesFound: number;
}

export interface OpportunityReadRepository {
  listOpportunities(): Promise<CrossVenueOpportunity[]>;
  getOpportunity(id: string): Promise<CrossVenueOpportunity | undefined>;
}

export interface MarketReadRepository {
  listMarkets(): Promise<NormalizedMarket[]>;
}

export interface ScanRunReadRepository {
  getLatestScanRun(): Promise<ScanRunReadModel>;
}

export const OPPORTUNITY_READ_REPOSITORY = Symbol("OPPORTUNITY_READ_REPOSITORY");
export const MARKET_READ_REPOSITORY = Symbol("MARKET_READ_REPOSITORY");
export const SCAN_RUN_READ_REPOSITORY = Symbol("SCAN_RUN_READ_REPOSITORY");

@Injectable()
export class OpportunityReadService {
  constructor(
    @Inject(OPPORTUNITY_READ_REPOSITORY)
    private readonly opportunities: OpportunityReadRepository
  ) {}

  listOpportunities(): Promise<CrossVenueOpportunity[]> {
    return this.opportunities.listOpportunities();
  }

  getOpportunity(id: string): Promise<CrossVenueOpportunity | undefined> {
    return this.opportunities.getOpportunity(id);
  }
}

@Injectable()
export class MarketReadService {
  constructor(
    @Inject(MARKET_READ_REPOSITORY)
    private readonly markets: MarketReadRepository
  ) {}

  listMarkets(): Promise<NormalizedMarket[]> {
    return this.markets.listMarkets();
  }
}

@Injectable()
export class ScanRunReadService {
  constructor(
    @Inject(SCAN_RUN_READ_REPOSITORY)
    private readonly scanRuns: ScanRunReadRepository
  ) {}

  getLatestScanRun(): Promise<ScanRunReadModel> {
    return this.scanRuns.getLatestScanRun();
  }
}
