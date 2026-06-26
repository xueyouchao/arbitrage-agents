import { ZodType, z } from "zod";
import { LlmOutputValidatorRegistry } from "./application/llm-output-validators";
import { LlmEvaluationRequest } from "./application/llm-evaluation";

/**
 * Scanner-side LLM response contract. Owning the normalization and
 * equivalence schemas here keeps scanner domain churn (new assets, new
 * event types, new operators) out of the generic persisted LLM gateway
 * (issue #14) and ensures the prompt-side and validator-side schemas stay
 * in sync (issue #15).
 */
export const SCANNER_LLM_NORMALIZATION_VERSION = "v1";
export const SCANNER_LLM_EQUIVALENCE_VERSION = "v1";

export const SCANNER_TOPICS = ["crypto", "macro", "sports", "politics", "current_events"] as const;
export const SCANNER_EVENT_TYPES = [
  "price_above",
  "price_below",
  "fed_rate_decision",
  "cpi_range",
  "winner",
  "total",
  "nomination",
  "yes_no"
] as const;
export const SCANNER_CRYPTO_ASSETS = ["BTC", "ETH"] as const;
export const SCANNER_OPERATORS = [">", ">=", "<", "<=", "=", "between"] as const;
export const SCANNER_PAYOFF_TYPES = ["at_time", "any_time_before", "range", "settlement_value"] as const;

export function marketNormalizationSchema(): ZodType<Record<string, unknown>> {
  // Issue #7: numeric fields accept either raw numbers or numeric strings
  // (e.g. `"threshold": "100000"`) via `z.coerce.number()` so valid
  // model responses that serialise numbers as strings do not get marked
  // failed and ignored by the scanner.
  return z
    .object({
      topic: z.enum(SCANNER_TOPICS),
      eventType: z.enum(SCANNER_EVENT_TYPES),
      asset: z.string().min(1).nullable(),
      threshold: z.coerce.number().finite().nullable(),
      operator: z.enum(SCANNER_OPERATORS).nullable(),
      deadline: z.string().datetime().nullable(),
      timezone: z.string().min(1).nullable(),
      resolutionSource: z.string().min(1).nullable(),
      payoffType: z.enum(SCANNER_PAYOFF_TYPES),
      confidence: z.coerce.number().min(0).max(1),
      ambiguityFlags: z.array(z.string())
    })
    .strict();
}

export function marketEquivalenceSchema(): ZodType<Record<string, unknown>> {
  return z
    .object({
      equivalent: z.boolean(),
      confidence: z.coerce.number().min(0).max(1),
      explanation: z.string().min(1)
    })
    .strict();
}

export function buildScannerLlmValidatorRegistry(): LlmOutputValidatorRegistry {
  return new LlmOutputValidatorRegistry()
    .register("market_normalization", SCANNER_LLM_NORMALIZATION_VERSION, marketNormalizationSchema())
    .register("market_equivalence", SCANNER_LLM_EQUIVALENCE_VERSION, marketEquivalenceSchema());
}

/**
 * Single source of truth for the prompt-side schema description. The
 * scanner owns the description so the prompt and the validator cannot
 * drift (issue #15). Both validation and prompt-construction consult the
 * same set of fields / enum values via `describeScannerSchema`.
 */
export function describeScannerSchema(taskType: LlmEvaluationRequest["taskType"]): Record<string, string> {
  if (taskType === "market_normalization") {
    return {
      topic: `${SCANNER_TOPICS.join("|")}`,
      eventType: `${SCANNER_EVENT_TYPES.join("|")}`,
      asset: "non-empty string|null",
      threshold: "number|null",
      operator: `${SCANNER_OPERATORS.join("|")}|null`,
      deadline: "ISO-8601 string|null",
      timezone: "string|null",
      resolutionSource: "string|null",
      payoffType: `${SCANNER_PAYOFF_TYPES.join("|")}`,
      confidence: "number 0..1",
      ambiguityFlags: "string[]"
    };
  }
  if (taskType === "market_equivalence") {
    return {
      equivalent: "boolean",
      confidence: "number 0..1",
      explanation: "non-empty string"
    };
  }
  return { explanation: "non-empty string" };
}
