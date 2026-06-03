import { NormalizedMarket } from "./normalized-market";

export type EquivalenceClass = "A" | "B" | "C" | "D";
export type PairDecision = "tradable" | "alert_only" | "reject" | "human_review";

export interface CandidatePair {
  id: string;
  kalshiMarket: NormalizedMarket;
  polymarketMarket: NormalizedMarket;
  reasons: string[];
}

export interface EquivalenceDecision {
  pairId: string;
  equivalenceClass: EquivalenceClass;
  decision: PairDecision;
  reasons: string[];
}
