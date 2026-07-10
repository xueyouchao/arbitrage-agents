import { EquivalenceClass } from "../../matching/domain/candidate-pair";
import { PayoffType, Venue } from "../../matching/domain/normalized-market";

export type ContractSide = "YES" | "NO";
export type RiskLevel = "low" | "medium" | "high";

// ADR-0002 §3.6: basis-risk classification for conditional settlement-triggered exit.
export type BasisRiskClass = "same_ref" | "diff_ref";

// ADR-0002 §3.1: phase 1 is conditional exit only. "always" (unconditional exit)
// is explicitly rejected as the default (§4.1) and has no phase-1 consumer; it is
// deferred until a future ADR approves an unconditional-exit mode.
export type ExitPolicy = "evaluate" | "hold";

// ADR-0002 §3.6: result of the t1 exit-cost + liquidity gate. Before t1 the field
// is `undefined` (not a sentinel) so the registry can distinguish evaluated from
// pending alerts.
export type GateResult = "pass" | "fail";

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

// ADR-0002 §3.6: computed risk structure stamped on each opportunity.
// Populated at detection time with classification fields; t1-evaluated fields are
// filled later by the exit-gate logic.
export interface RiskStructure {
  // The leg that settles first (earlier deadline).
  earlyLeg: { venue: Venue; marketId: string; side: ContractSide; deadline?: string };
  // The leg that settles later and is still tradeable at t1.
  survivingLeg: { venue: Venue; marketId: string; side: ContractSide; deadline?: string };
  // Absolute deadline gap in hours. ~0 means simultaneous settlement.
  dtHours: number;
  // Whether both legs settle against the same reference (same_ref) or different (diff_ref).
  basisRiskClass: BasisRiskClass;
  // Payoff type of the surviving leg, surfaced for the exit model.
  payoffType: PayoffType;
  // 'evaluate' = run the t1 exit gate (sequential settlement, dtHours > 0);
  // 'hold' = hold to t2 (simultaneous settlement). Unconditional exit ("always")
  // is intentionally not in the type — it is deferred per ADR §3.1/§4.1.
  exitPolicy: ExitPolicy;
  // --- t1-evaluated fields (populated at t1, absent at detection time) ---
  // Value locked by selling the surviving leg at t1 bid.
  lockValue?: number;
  // Expected value of holding the surviving leg to t2.
  holdExpectedValue?: number;
  // Estimated cost to exit: sellFee + estimatedSpread + estimatedSlippage.
  exitCost?: number;
  // Result of the exit-cost + liquidity gates. `undefined` until t1 runs.
  gateResult?: GateResult;
  // Recommended sell price (surviving-leg bid at t1).
  recommendedSellPrice?: number;
  // Recommended sell size, capped by the liquidity haircut.
  recommendedSellSize?: number;
  // Human-readable reasoning for the gate decision (auditable).
  reasoning?: string;
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
  firstDetectedAt: string;
  lastVerifiedAt: string;
  calculationVersion: string;
  configVersion: string;
  // ADR-0002 §3.6: optional risk-structure block derived from opportunity/market fields.
  // Kept optional so existing consumers and calculators are not affected.
  riskStructure?: RiskStructure;
}
