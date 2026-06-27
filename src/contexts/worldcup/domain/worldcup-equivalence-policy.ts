/**
 * Emergency World Cup 2026 equivalence policy.
 *
 * Simplified replacement for `DeterministicEquivalencePolicy` that only
 * handles World Cup markets. Because World Cup tournament winner markets
 * on Kalshi and Polymarket both resolve against the same body (FIFA),
 * resolution-source mismatches are extremely rare, and the team code
 * already provides a stable cross-venue key.
 *
 * Decision logic:
 *   - Both teams resolved AND same code AND same market type → class A
 *   - Otherwise → class C (reject)
 *
 * No class B/D is produced — the emergency module is intentionally strict
 * so we only surface high-confidence opportunities.
 *
 * @emergency Drop this when topic normalisation provides stable team keys
 * across venues and use the generic DeterministicEquivalencePolicy.
 */

import { EquivalenceDecision } from "../../matching/domain/candidate-pair";
import { WorldCupCandidatePair } from "./worldcup-pair-matcher";

export function classifyWorldCupPair(pair: WorldCupCandidatePair): EquivalenceDecision {
  const left = pair.kalshiMarket;
  const right = pair.polymarketMarket;

  // Both team codes must be resolved to the same canonical code.
  if (!left.teamResolved || !right.teamResolved) {
    return {
      pairId: pair.id,
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["wc_team_unresolved"],
    };
  }

  if (left.teamCode !== right.teamCode) {
    return {
      pairId: pair.id,
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["wc_team_code_mismatch"],
    };
  }

  if (left.marketType !== right.marketType) {
    return {
      pairId: pair.id,
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["wc_market_type_mismatch"],
    };
  }

  // Match markets must agree on opponent too.
  if ((left.opponentCode ?? "_") !== (right.opponentCode ?? "_")) {
    return {
      pairId: pair.id,
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["wc_opponent_mismatch"],
    };
  }

  // Threshold must agree when present.
  if ((left.threshold ?? null) !== (right.threshold ?? null)) {
    return {
      pairId: pair.id,
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["wc_threshold_mismatch"],
    };
  }

  return {
    pairId: pair.id,
    equivalenceClass: "A",
    decision: "tradable",
    reasons: [
      "wc_team_match",
      `wc_${left.teamCode}`,
      `wc_type_${left.marketType}`,
    ],
  };
}
