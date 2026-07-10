import { CandidatePair, EquivalenceDecision } from "./candidate-pair";
import { bothCryptoPriceLevels } from "./crypto-market";

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

  const thresholdMatch = thresholdsMatch(left.threshold, right.threshold, left, right);
  if (!thresholdMatch.exact) {
    if (thresholdMatch.compatible) {
      advisoryReasons.push("threshold_close_but_not_identical");
    } else {
      hardReasons.push("threshold_mismatch");
    }
  }

  const deadlineMatch = deadlinesMatch(left.deadline, right.deadline, left, right);
  if (!deadlineMatch.exact) {
    if (deadlineMatch.compatible) {
      advisoryReasons.push("deadline_same_day_time_differs");
    } else {
      hardReasons.push("deadline_mismatch");
    }
  }

  return { hardReasons, advisoryReasons };
}

interface ThresholdMatch {
  exact: boolean;
  compatible: boolean;
}

function thresholdsMatch(
  left?: number,
  right?: number,
  leftMarket?: { readonly topic: string; readonly eventType: string },
  rightMarket?: { readonly topic: string; readonly eventType: string }
): ThresholdMatch {
  // Non-numeric markets (sports winner, politics election, current-event
  // yes/no) have no threshold. Treat undefined-on-both as compatible so
  // they pass equivalence classification instead of being rejected as C.
  // This mirrors candidate-pair-generator.ts thresholdsMatch.
  if (left === undefined && right === undefined) return { exact: true, compatible: true };
  // Exactly-one undefined means one venue provided a threshold and the
  // other didn't — asymmetric inputs are not equivalent.
  if (left === undefined || right === undefined) return { exact: false, compatible: false };

  const diff = Math.abs(left - right);
  if (diff < 0.000001) {
    return { exact: true, compatible: true };
  }

  // Crypto price-level markets use slightly different strike ladders across
  // venues (e.g. Polymarket "$52,000" vs Kalshi "$51,999.99"). Treat strikes
  // within $1 as compatible; the equivalence policy records the residual
  // difference as an advisory reason.
  if (leftMarket && rightMarket && bothCryptoPriceLevels(leftMarket, rightMarket) && diff <= 1) {
    return { exact: false, compatible: true };
  }

  return { exact: false, compatible: false };
}

interface DeadlineMatch {
  exact: boolean;
  compatible: boolean;
}

function deadlinesMatch(
  left?: string,
  right?: string,
  leftMarket?: { readonly topic: string; readonly eventType: string },
  rightMarket?: { readonly topic: string; readonly eventType: string }
): DeadlineMatch {
  if (!left || !right) return { exact: false, compatible: false };
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return { exact: false, compatible: false };

  const diffMs = Math.abs(leftTime - rightTime);
  if (diffMs <= 60 * 1000) {
    return { exact: true, compatible: true };
  }

  if (leftMarket && rightMarket && bothCryptoPriceLevels(leftMarket, rightMarket) && sameUtcDay(leftTime, rightTime)) {
    return { exact: false, compatible: true };
  }

  return { exact: false, compatible: false };
}

function sameUtcDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}
