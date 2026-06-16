import { EquivalenceClass } from "../../matching/domain/candidate-pair";
import { Venue } from "../../matching/domain/normalized-market";

export type ContractSide = "YES" | "NO";
export type RiskLevel = "low" | "medium" | "high";
export type FeeModel = FlatFeeModel | KalshiFeeModel | PolymarketFeeModel;
export type VenueFeeModel = { kalshi: KalshiFeeModel; polymarket: PolymarketFeeModel }[Venue];
export type FeeModels = { [V in Venue]?: VenueFeeModel | FlatFeeModel };

export interface FlatFeeModel {
  type: "flat";
  rate: number;
  version?: string;
}

export interface KalshiFeeModel {
  type: "kalshi";
  rate: number;
  version?: string;
}

export interface PolymarketFeeModel {
  type: "polymarket";
  feeRateBps?: number;
  makerFeeRateBps?: number;
  takerFeeRateBps?: number;
  orderRole?: "maker" | "taker";
  operatorFeeRateBps?: number;
  version?: string;
}

export interface PriceLevel {
  price: number;
  size: number;
}

export interface ContractLeg {
  venue: Venue;
  marketId: string;
  side: ContractSide;
  askPrice: number;
  availableUsd: number;
  feeRate?: number;
  slippageRate?: number;
  feeModelVersion?: string;
  feeModel?: FeeModel;
  depthLevels?: PriceLevel[];
}

export interface MarketBook {
  marketId: string;
  venue: Venue;
  yesAsk: number;
  noAsk: number;
  yesAvailableUsd: number;
  noAvailableUsd: number;
  yesDepth?: PriceLevel[];
  noDepth?: PriceLevel[];
  capturedAt: string;
  stale?: boolean;
  rawPayload?: Record<string, unknown>;
}

export interface NotionalEdge {
  targetNotionalUsd: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  fillable: boolean;
}

export interface CrossVenueOpportunity {
  id: string;
  pairId: string;
  longLeg: ContractLeg;
  hedgeLeg: ContractLeg;
  combinedCost: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  maxTradableUsd: number;
  notionalEdges: NotionalEdge[];
  equivalenceClass: EquivalenceClass;
  resolutionRisk: RiskLevel;
  fillRisk: RiskLevel;
  liquidityRisk: RiskLevel;
  venueRisk: RiskLevel;
  equivalenceRisk: RiskLevel;
  dataStalenessMs: number;
  opportunityAgeMs: number;
  detectedAt: string;
  lastVerifiedAt: string;
  calculationVersion: string;
  configVersion: string;
}
