import { describe, expect, it } from "vitest";
import { LlmCostCalculator, estimateLlmCost } from "../src/contexts/llm/application/llm-cost-calculator";

describe("LlmCostCalculator", () => {
  const pricing = new LlmCostCalculator({
    "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 },
    "gpt-4o-mini": { promptPer1M: 0.15, completionPer1M: 0.6 },
    "minimax-m3:cloud": { promptPer1M: 0.2, completionPer1M: 0.8 },
    "glm-5.2:cloud": { promptPer1M: 0.2, completionPer1M: 0.8 }
  });

  it("computes cost from prompt and completion tokens using model pricing", () => {
    // 1M prompt tokens × $2.50/1M + 500K completion tokens × $10/1M
    const cost = pricing.calculate("gpt-4o", { promptTokens: 1_000_000, completionTokens: 500_000 });
    expect(cost).toBeCloseTo(2.5 + 5.0, 6); // $7.50
  });

  it("returns 0 for an unknown model", () => {
    const cost = pricing.calculate("unknown-model", { promptTokens: 1_000, completionTokens: 500 });
    expect(cost).toBe(0);
  });

  it("returns 0 when both token counts are 0", () => {
    const cost = pricing.calculate("gpt-4o", { promptTokens: 0, completionTokens: 0 });
    expect(cost).toBe(0);
  });

  it("handles fractional token counts correctly", () => {
    // 100 prompt tokens × $0.15/1M = 0.000015
    // 50 completion tokens × $0.60/1M = 0.000030
    const cost = pricing.calculate("gpt-4o-mini", { promptTokens: 100, completionTokens: 50 });
    expect(cost).toBeCloseTo(0.000015 + 0.00003, 10);
  });

  it("uses the project default model pricing", () => {
    // glm-5.2:cloud is the default model in app-config
    // 10K prompt × $0.20/1M = 0.002, 5K completion × $0.80/1M = 0.004
    const cost = pricing.calculate("glm-5.2:cloud", { promptTokens: 10_000, completionTokens: 5_000 });
    expect(cost).toBeCloseTo(0.002 + 0.004, 8); // $0.006
  });
});

describe("estimateLlmCost (convenience function)", () => {
  it("computes cost using the built-in default pricing table", () => {
    // Should work out-of-the-box without the caller providing a pricing map
    const cost = estimateLlmCost("gpt-4o", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(cost).toBeGreaterThan(0);
  });

  it("returns 0 for unknown models via the convenience function", () => {
    const cost = estimateLlmCost("totally-unknown-model", { promptTokens: 1000, completionTokens: 500 });
    expect(cost).toBe(0);
  });
});
