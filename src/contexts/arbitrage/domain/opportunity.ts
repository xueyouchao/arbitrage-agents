import { EquivalenceClass } from "../../matching/domain/candidate-pair";
import { Venue } from "../../matching/domain/normalized-market";

export type ContractSide = "YES" | "NO";
export type RiskLevel = "low" | "medium" | "high";

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
  theoreticalCombinedCost: number;
  theoreticalGrossEdge: number;
  theoreticalNetEdge: number;
  executableSizeUsd: number;
  executableCombinedCost: number;
  executableGrossEdge: number;
  executableNetEdge: number;
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
