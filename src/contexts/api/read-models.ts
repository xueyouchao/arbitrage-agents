import { Inject, Injectable } from "@nestjs/common";
import { ContractLeg, RiskLevel } from "../arbitrage/domain/opportunity";
import { EquivalenceClass } from "../matching/domain/candidate-pair";
import { CryptoAsset, EventType, MarketOperator, PayoffType, Topic, Venue } from "../matching/domain/normalized-market";

export interface OpportunityReadModel {
  id: string;
  pairId: string;
  kalshiOrderbookSnapshotId?: string;
  polymarketOrderbookSnapshotId?: string;
  longLeg: ContractLeg;
  hedgeLeg: ContractLeg;
  combinedCost: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  maxTradableUsd: number;
  equivalenceClass: EquivalenceClass;
  resolutionRisk: RiskLevel;
  fillRisk: RiskLevel;
  detectedAt: string;
  lastVerifiedAt: string;
}

export interface MarketReadModel {
  id: string;
  venue: Venue;
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  topic: Topic;
  eventType: EventType;
  asset?: CryptoAsset;
  threshold?: number;
  operator?: MarketOperator;
  deadline?: string;
  timezone?: string;
  resolutionSource?: string;
  payoffType: PayoffType;
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
