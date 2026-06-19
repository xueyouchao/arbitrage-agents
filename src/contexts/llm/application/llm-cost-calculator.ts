// Pure cost calculator for LLM evaluations. Computes estimatedCostUsd
// from token counts and a per-model pricing table. Prices are expressed
// as USD per 1 000 000 tokens (the convention used by OpenAI, Anthropic,
// and most hosted providers).
//
// Unknown models return 0 rather than throwing — the scanner must never
// fail a scan because a pricing row is missing. The convenience function
// `estimateLlmCost` ships with a built-in default pricing table that
// covers the models currently used in production and CI.

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export class LlmCostCalculator {
  constructor(private readonly pricing: Record<string, ModelPricing>) {}

  calculate(model: string, usage: TokenUsage): number {
    const rates = this.pricing[model];
    if (!rates) return 0;
    return (usage.promptTokens / 1_000_000) * rates.promptPer1M
         + (usage.completionTokens / 1_000_000) * rates.completionPer1M;
  }
}

// Default pricing table. Keep this in sync with the models listed in
// app-config.ts `llmModel` defaults and any production overrides.
// Prices last verified against provider pricing pages; update when
// providers adjust their rates.
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "gpt-4o":             { promptPer1M: 2.50, completionPer1M: 10.00 },
  "gpt-4o-mini":        { promptPer1M: 0.15, completionPer1M: 0.60 },
  "gpt-4.1":            { promptPer1M: 2.00, completionPer1M: 8.00 },
  "gpt-4.1-mini":       { promptPer1M: 0.40, completionPer1M: 1.60 },
  "gpt-4.1-nano":       { promptPer1M: 0.10, completionPer1M: 0.40 },
  "o3-mini":            { promptPer1M: 1.10, completionPer1M: 4.40 },
  "minimax-m3:cloud":   { promptPer1M: 0.20, completionPer1M: 0.80 },
  "glm-5.2:cloud":      { promptPer1M: 0.20, completionPer1M: 0.80 },
};

const defaultCalculator = new LlmCostCalculator(DEFAULT_PRICING);

/** Convenience: compute cost using the built-in default pricing table. */
export function estimateLlmCost(model: string, usage: TokenUsage): number {
  return defaultCalculator.calculate(model, usage);
}
