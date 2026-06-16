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

export interface ApiPriceLevel {
  price: number;
  size: number;
}

export interface ApiContractLeg {
  venue: ApiVenue;
  marketId: string;
  side: ApiContractSide;
  askPrice: number;
  availableUsd: number;
  feeRate?: number;
  slippageRate?: number;
  depthLevels?: ApiPriceLevel[];
}

export interface NotionalEdgeReadModel {
  targetNotionalUsd: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  fillable: boolean;
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
  theoreticalCombinedCost: number;
  theoreticalGrossEdge: number;
  theoreticalNetEdge: number;
  executableSizeUsd: number;
  executableCombinedCost: number;
  executableGrossEdge: number;
  executableNetEdge: number;
  maxTradableUsd: number;
  notionalEdges: NotionalEdgeReadModel[];
  equivalenceClass: ApiEquivalenceClass;
  resolutionRisk: ApiRiskLevel;
  fillRisk: ApiRiskLevel;
  liquidityRisk: ApiRiskLevel;
  venueRisk: ApiRiskLevel;
  equivalenceRisk: ApiRiskLevel;
  dataStalenessMs: number;
  opportunityAgeMs: number;
  detectedAt: string;
  firstDetectedAt: string;
  lastVerifiedAt: string;
  calculationVersion: string;
  configVersion: string;
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
  // Phase 4: `abandoned` is a terminal status for scans whose worker
  // died before finalize. The API surfaces it so an operator can
  // distinguish a failed scan from one the worker simply never
  // reported back from.
  status: "running" | "succeeded" | "failed" | "abandoned";
  startedAt: string;
  completedAt?: string;
  marketsScanned: number;
  opportunitiesFound: number;
  failureCategory?: "fetch" | "processing" | "persistence" | "abandoned";
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
