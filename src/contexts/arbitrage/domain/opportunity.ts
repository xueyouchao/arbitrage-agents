import { EquivalenceClass } from "../../matching/domain/candidate-pair";
import { Venue } from "../../matching/domain/normalized-market";

export type ContractSide = "YES" | "NO";
export type RiskLevel = "low" | "medium" | "high";

export interface ContractLeg {
  venue: Venue;
  marketId: string;
  side: ContractSide;
  askPrice: number;
  availableUsd: number;
}

export interface MarketBook {
  marketId: string;
  venue: Venue;
  yesAsk: number;
  noAsk: number;
  yesAvailableUsd: number;
  noAvailableUsd: number;
  capturedAt: string;
  stale?: boolean;
  rawPayload?: Record<string, unknown>;
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
  equivalenceClass: EquivalenceClass;
  resolutionRisk: RiskLevel;
  fillRisk: RiskLevel;
  detectedAt: string;
  lastVerifiedAt: string;
}
