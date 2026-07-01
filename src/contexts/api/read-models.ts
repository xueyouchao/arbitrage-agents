import { Inject, Injectable } from "@nestjs/common";

export type ApiVenue = "kalshi" | "polymarket";
export type ApiContractSide = "YES" | "NO";
export type ApiRiskLevel = "low" | "medium" | "high";
export type ApiEquivalenceClass = "A" | "B" | "C" | "D";
export type ApiTopic = "crypto" | "macro" | "sports" | "politics" | "current_events";
export type ApiEventType =
  | "price_above" | "price_below"
  | "fed_rate_decision" | "cpi_range"
  | "winner" | "total" | "nomination" | "yes_no";
export type ApiCryptoAsset = string;
export type ApiMarketOperator = ">" | ">=" | "<" | "<=" | "=" | "between";
export type ApiAsset = string;
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
  humanReviewFlag?: "pending" | "approved" | "rejected";
  humanReviewNotes?: string;
}

export interface MarketReadModel {
  id: string;
  venue: ApiVenue;
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  topic: ApiTopic;
  eventType: ApiEventType;
  asset?: ApiAsset;
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

export interface PaperTradeLegFillReadModel {
  averagePrice: number;
  contracts: number;
  fees: number;
  slippage: number;
}

export interface PaperTradeSimulationReadModel {
  id: string;
  opportunityId: string;
  simulatedAt: string;
  targetNotionalUsd: number;
  longLegFill: PaperTradeLegFillReadModel;
  hedgeLegFill: PaperTradeLegFillReadModel;
  adverseSelectionBps: number;
  partialFill: boolean;
  residualExposureUsd: number;
  combinedCost: number;
  grossEdge: number;
  netEdge: number;
  configVersion: string;
  calculationVersion: string;
}

export interface PaperTradeSimulationReadRepository {
  listPaperTradeSimulations(opportunityId: string): Promise<PaperTradeSimulationReadModel[]>;
}

export interface PaginationParams {
  offset: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface OpportunityFilters {
  equivalenceClass?: ApiEquivalenceClass;
  minNetEdge?: number;
  maxDataStalenessMs?: number;
  resolutionRisk?: ApiRiskLevel;
  fillRisk?: ApiRiskLevel;
  humanReviewFlag?: "pending" | "approved" | "rejected";
}

export interface OpportunitySort {
  field: "detectedAt" | "netEdge" | "opportunityAgeMs" | "equivalenceClass";
  order: "asc" | "desc";
}

export interface OpportunityReadRepository {
  listOpportunities(params?: {
    pagination?: PaginationParams;
    filters?: OpportunityFilters;
    sort?: OpportunitySort;
  }): Promise<PaginatedResponse<OpportunityReadModel>>;
  getOpportunity(id: string): Promise<OpportunityReadModel | undefined>;
}

export interface MarketReadRepository {
  listMarkets(params?: {
    pagination?: PaginationParams;
  }): Promise<PaginatedResponse<MarketReadModel>>;
}

export interface ScanRunReadRepository {
  getLatestScanRun(): Promise<ScanRunReadModel>;
}

/**
 * A position as surfaced by the `GET /v1/positions` dashboard endpoint
 * (issue #81). Combines data from the `positions` table with the related
 * `orders` rows so the dashboard can show venue + market per leg.
 */
export interface PositionReadModel {
  id: string;
  opportunityId: string;
  status: "open" | "partial" | "exposed" | "closed";
  kalshiOrderId: string | null;
  polyOrderId: string | null;
  kalshiMarket: string | null;
  polymarketMarket: string | null;
  kalshiVenue: string | null;
  polymarketVenue: string | null;
  /** Total notional deployed in this position (sum of both leg fill sizes). */
  notionalUsd: number;
  /** Realised P&L for closed positions, mark-to-market for open positions. */
  pnl: number;
  createdAt: string;
}

/**
 * Capital utilization summary returned alongside the positions list so the
 * dashboard can show how much of the max-capital-deployed budget is in use.
 */
export interface CapitalUtilizationSummary {
  totalOpenNotional: number;
  maxCapitalDeployed: number;
  utilizationPct: number;
}

export interface PositionReadRepository {
  listOpenPositions(): Promise<PositionReadModel[]>;
  getCapitalUtilization(maxCapitalDeployed: number): Promise<CapitalUtilizationSummary>;
}

export const OPPORTUNITY_READ_REPOSITORY = Symbol("OPPORTUNITY_READ_REPOSITORY");
export const MARKET_READ_REPOSITORY = Symbol("MARKET_READ_REPOSITORY");
export const SCAN_RUN_READ_REPOSITORY = Symbol("SCAN_RUN_READ_REPOSITORY");
export const PAPER_TRADE_SIMULATION_READ_REPOSITORY = Symbol("PAPER_TRADE_SIMULATION_READ_REPOSITORY");
export const POSITION_READ_REPOSITORY = Symbol("POSITION_READ_REPOSITORY");

@Injectable()
export class OpportunityReadService {
  constructor(
    @Inject(OPPORTUNITY_READ_REPOSITORY)
    private readonly opportunities: OpportunityReadRepository
  ) {}

  listOpportunities(params?: {
    pagination?: PaginationParams;
    filters?: OpportunityFilters;
    sort?: OpportunitySort;
  }): Promise<PaginatedResponse<OpportunityReadModel>> {
    return this.opportunities.listOpportunities(params);
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

  listMarkets(params?: {
    pagination?: PaginationParams;
  }): Promise<PaginatedResponse<MarketReadModel>> {
    return this.markets.listMarkets(params);
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

@Injectable()
export class PaperTradeSimulationReadService {
  constructor(
    @Inject(PAPER_TRADE_SIMULATION_READ_REPOSITORY)
    private readonly paperTradeSimulations: PaperTradeSimulationReadRepository
  ) {}

  listPaperTradeSimulations(opportunityId: string): Promise<PaperTradeSimulationReadModel[]> {
    return this.paperTradeSimulations.listPaperTradeSimulations(opportunityId);
  }
}

@Injectable()
export class PositionReadService {
  constructor(
    @Inject(POSITION_READ_REPOSITORY)
    private readonly positions: PositionReadRepository
  ) {}

  listOpenPositions(): Promise<PositionReadModel[]> {
    return this.positions.listOpenPositions();
  }

  getCapitalUtilization(maxCapitalDeployed: number): Promise<CapitalUtilizationSummary> {
    return this.positions.getCapitalUtilization(maxCapitalDeployed);
  }
}
