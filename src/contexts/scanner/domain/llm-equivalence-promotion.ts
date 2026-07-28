import { EquivalenceDecision } from "../../matching/domain/candidate-pair";

/**
 * Promotes the equivalence class of a candidate pair based on an LLM verdict.
 *
 * - D-class pairs (low_normalization_confidence) are downgraded to B when the
 *   LLM clears the human-review need, but cannot reach A.
 * - B-class pairs can be promoted to A only when the LLM confidence is high
 *   (>= 0.9) and every reason on the decision is in the explicit soft-reason
 *   allowlist. A hand-maintained denylist of hard reasons is fragile when the
 *   policy grows new reasons; an allowlist is the safe default. Pair-level
 *   reasons that did not come from DeterministicEquivalencePolicy are
 *   conservatively treated as hard until they are explicitly allowed.
 */
export function promoteEquivalenceClass(
  decision: EquivalenceDecision,
  confidence: number,
): EquivalenceDecision["equivalenceClass"] {
  if (confidence < 0.7) return decision.equivalenceClass;
  if (decision.equivalenceClass === "D") return "B";
  if (decision.equivalenceClass !== "B") return decision.equivalenceClass;
  if (confidence < 0.9) return "B";
  const allReasonsSoft = decision.reasons.every((reason) =>
    SOFT_REVIEW_REASONS.has(reason),
  );
  return allReasonsSoft ? "A" : "B";
}

export function promoteEquivalenceDecision(
  decision: EquivalenceDecision,
  promotedClass: EquivalenceDecision["equivalenceClass"],
): EquivalenceDecision["decision"] {
  if (promotedClass === "A") return "tradable";
  if (promotedClass === "B")
    return decision.decision === "tradable" ? "tradable" : "alert_only";
  if (promotedClass === "C") return "reject";
  return decision.decision;
}

/**
 * Soft reasons that the LLM equivalence promotion is allowed to override.
 *
 * Centralizing this allowlist makes future advisory-reason changes a single
 * edit that affects both production and PMXT Router shadow paths.
 */
export const SOFT_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "ambiguity_flags_present",
  "resolution_source_missing",
  "resolution_source_differs",
  "resolution_source_differs_crypto_index",
  "deadline_within_relaxed_tolerance",
  "threshold_close_but_not_identical",
  "llm_inconclusive",
  "llm_supported_equivalence",
  "deterministic_fields_match",
]);
