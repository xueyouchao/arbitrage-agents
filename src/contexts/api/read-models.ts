import { Inject, Injectable } from "@nestjs/common";

export type ApiVenue = "kalshi" | "polymarket";
export type ApiContractSide = "YES" | "NO";
export type ApiRiskLevel = "low" | "medium" | "high";
export type ApiEquivalenceClass = "A" | "B" | "C" | "D";
export type ApiTopic = "crypto" | "macro";
export type ApiEventType = "price_above" | "price_below" | "fed_rate_decision" | "cpi_range";
export type ApiCryptoAsset = "BTC" | "ETH";
export type ApiMarketOperator = ">" | ">=" | "<" | "<=" | "=" | "between";
export type ApiPayoffType = "at_time" | "any_time_before" | "range" | "settlement_value";

export interface ApiContractLeg {
  venue: ApiVenue;
  marketId: string;
  side: ApiContractSide;
  askPrice: number;
  availableUsd: number;
}

export interface OpportunityReadModel {
  id: string;
  pairId: string;
  kalshiOrderbookSnapshotId?: string;
  polymarketOrderbookSnapshotId?: string;
  longLeg: ApiContractLeg;
  hedgeLeg: ApiContractLeg;
  combinedCost: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  maxTradableUsd: number;
  equivalenceClass: ApiEquivalenceClass;
  resolutionRisk: ApiRiskLevel;
  fillRisk: ApiRiskLevel;
  detectedAt: string;
  lastVerifiedAt: string;
}

export interface MarketReadModel {
  id: string;
  venue: ApiVenue;
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  topic: ApiTopic;
  eventType: ApiEventType;
  asset?: ApiCryptoAsset;
  threshold?: number;
  operator?: ApiMarketOperator;
  deadline?: string;
  timezone?: string;
  resolutionSource?: string;
  payoffType: ApiPayoffType;
  ambiguityFlags: string[];
  confidence: number;
}

export interface ScanRunReadModel {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  marketsScanned: number;
  opportunitiesFound: number;
  failureCategory?: "fetch" | "processing" | "persistence";
  failureReason?: string;
}

export interface OpportunityReadRepository {
  listOpportunities(): Promise<OpportunityReadModel[]>;
  getOpportunity(id: string): Promise<OpportunityReadModel | undefined>;
}

export interface MarketReadRepository {
  listMarkets(): Promise<MarketReadModel[]>;
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

  listOpportunities(): Promise<OpportunityReadModel[]> {
    return this.opportunities.listOpportunities();
  }

  getOpportunity(id: string): Promise<OpportunityReadModel | undefined> {
    return this.opportunities.getOpportunity(id);
  }
}

@Injectable()
export class MarketReadService {
  constructor(
    @Inject(MARKET_READ_REPOSITORY)
    private readonly markets: MarketReadRepository
  ) {}

  listMarkets(): Promise<MarketReadModel[]> {
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
