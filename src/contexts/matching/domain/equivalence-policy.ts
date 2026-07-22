import { CandidatePair, EquivalenceDecision } from "./candidate-pair";
import { bothCryptoPriceLevels } from "./crypto-market";
import { deadlinesCompatible, thresholdsCompatible } from "./market-compatibility";

export class DeterministicEquivalencePolicy {
  classify(pair: CandidatePair): EquivalenceDecision {
    const left = pair.kalshiMarket;
    const right = pair.polymarketMarket;
    const reasons: string[] = [];

    if (left.confidence < 0.6 || right.confidence < 0.6) {
      return { pairId: pair.id, equivalenceClass: "D", decision: "human_review", reasons: ["low_normalization_confidence"] };
    }

    const { hardReasons, advisoryReasons } = materialMismatchReasonsFor(pair);
    if (hardReasons.length > 0) {
      return { pairId: pair.id, equivalenceClass: "C", decision: "reject", reasons: hardReasons };
    }

    if (left.ambiguityFlags.length > 0 || right.ambiguityFlags.length > 0) {
      reasons.push("ambiguity_flags_present");
    }

    const leftSource = normalizeResolutionSource(left.resolutionSource);
    const rightSource = normalizeResolutionSource(right.resolutionSource);
    if (!leftSource || !rightSource) {
      reasons.push("resolution_source_missing");
    } else if (leftSource !== rightSource) {
      // Crypto price-level markets settle against different index
      // providers/exchanges across venues (Kalshi: CF Benchmarks Real-Time
      // Index, Polymarket: Binance/UMA). For cross-venue crypto arbitrage this
      // is a known, acceptable basis risk, so record it as advisory rather than
      // blocking class A.
      if (bothCryptoPriceLevels(left, right)) {
        advisoryReasons.push("resolution_source_differs_crypto_index");
      } else {
        reasons.push("resolution_source_differs");
      }
    }

    // Advisory reasons alone (crypto strike/deadline/source residuals) do not
    // block class A. They are still surfaced on the decision for observability
    // and downstream LLM review, but the pair is tradable deterministically.
    if (reasons.length > 0) {
      return { pairId: pair.id, equivalenceClass: "B", decision: "alert_only", reasons: [...reasons, ...advisoryReasons] };
    }

    const allReasons = advisoryReasons.length > 0 ? advisoryReasons : ["deterministic_fields_match"];
    return { pairId: pair.id, equivalenceClass: "A", decision: "tradable", reasons: allReasons };
  }
}

function normalizeResolutionSource(source?: string): string | undefined {
  const normalized = source?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function materialMismatchReasonsFor(pair: CandidatePair): { hardReasons: string[]; advisoryReasons: string[] } {
  const left = pair.kalshiMarket;
  const right = pair.polymarketMarket;
  const hardReasons: string[] = [];
  const advisoryReasons: string[] = [];

  if (left.topic !== right.topic) hardReasons.push("topic_mismatch");
  if (left.asset !== right.asset) hardReasons.push("asset_mismatch");
  if (left.eventType !== right.eventType) hardReasons.push("event_type_mismatch");
  if (left.payoffType !== right.payoffType) hardReasons.push("payoff_type_mismatch");
  if (left.operator !== right.operator) hardReasons.push("operator_mismatch");

  const thresholdMatch = thresholdsCompatible(left.threshold, right.threshold, left, right);
  if (!thresholdMatch.exact) {
    if (thresholdMatch.compatible) {
      advisoryReasons.push("threshold_close_but_not_identical");
    } else {
      hardReasons.push("threshold_mismatch");
    }
  }

  const deadlineMatch = deadlinesCompatible(left.deadline, right.deadline, left, right);
  if (!deadlineMatch.exact) {
    if (deadlineMatch.compatible) {
      advisoryReasons.push("deadline_same_day_time_differs");
    } else {
      hardReasons.push("deadline_mismatch");
    }
  }

  return { hardReasons, advisoryReasons };
}
