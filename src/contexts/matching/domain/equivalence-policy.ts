import { CandidatePair, EquivalenceDecision } from "./candidate-pair";

export class DeterministicEquivalencePolicy {
  classify(pair: CandidatePair): EquivalenceDecision {
    const left = pair.kalshiMarket;
    const right = pair.polymarketMarket;
    const reasons: string[] = [];

    if (left.confidence < 0.6 || right.confidence < 0.6) {
      return { pairId: pair.id, equivalenceClass: "D", decision: "human_review", reasons: ["low_normalization_confidence"] };
    }

    const materialMismatchReasons = materialMismatchReasonsFor(pair);
    if (materialMismatchReasons.length > 0) {
      return { pairId: pair.id, equivalenceClass: "C", decision: "reject", reasons: materialMismatchReasons };
    }

    if (left.ambiguityFlags.length > 0 || right.ambiguityFlags.length > 0) {
      reasons.push("ambiguity_flags_present");
    }

    const leftSource = normalizeResolutionSource(left.resolutionSource);
    const rightSource = normalizeResolutionSource(right.resolutionSource);
    if (!leftSource || !rightSource) {
      reasons.push("resolution_source_missing");
    } else if (leftSource !== rightSource) {
      reasons.push("resolution_source_differs");
    }

    if (reasons.length > 0) {
      return { pairId: pair.id, equivalenceClass: "B", decision: "alert_only", reasons };
    }

    return { pairId: pair.id, equivalenceClass: "A", decision: "tradable", reasons: ["deterministic_fields_match"] };
  }
}

function normalizeResolutionSource(source?: string): string | undefined {
  const normalized = source?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}


function materialMismatchReasonsFor(pair: CandidatePair): string[] {
  const left = pair.kalshiMarket;
  const right = pair.polymarketMarket;
  const reasons: string[] = [];

  if (left.topic !== right.topic) reasons.push("topic_mismatch");
  if (left.asset !== right.asset) reasons.push("asset_mismatch");
  if (left.eventType !== right.eventType) reasons.push("event_type_mismatch");
  if (left.payoffType !== right.payoffType) reasons.push("payoff_type_mismatch");
  if (left.operator !== right.operator) reasons.push("operator_mismatch");
  if (!thresholdsMatch(left.threshold, right.threshold)) reasons.push("threshold_mismatch");
  if (!deadlinesMatch(left.deadline, right.deadline)) reasons.push("deadline_mismatch");

  return reasons;
}

function thresholdsMatch(left?: number, right?: number): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return Math.abs(left - right) < 0.000001;
}

function deadlinesMatch(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  return Math.abs(leftTime - rightTime) <= 60 * 1000;
}
