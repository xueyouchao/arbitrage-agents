import { describe, expect, it } from "vitest";
import {
  buildScannerLlmValidatorRegistry,
  describeScannerSchema,
} from "../src/contexts/llm/scanner-llm-validators";

describe("scanner-llm-validators", () => {
  const registry = buildScannerLlmValidatorRegistry();

  function validNormalizationOutput() {
    return {
      topic: "crypto",
      eventType: "price_above",
      asset: "BTC",
      threshold: 100000,
      operator: ">",
      deadline: "2026-01-01T00:00:00.000Z",
      timezone: "UTC",
      resolutionSource: "Coinbase BTC/USD",
      payoffType: "at_time",
      confidence: 0.9,
      ambiguityFlags: [],
    };
  }

  describe("topic enum widening", () => {
    it.each([
      { topic: "crypto", eventType: "price_above" },
      { topic: "macro", eventType: "cpi_range" },
      { topic: "sports", eventType: "winner" },
      { topic: "politics", eventType: "nomination" },
      { topic: "current_events", eventType: "yes_no" },
    ])("accepts topic=%s", (override) => {
      const output = { ...validNormalizationOutput(), ...override };
      expect(registry.validate("market_normalization", output)).toBeDefined();
    });

    it("rejects an unknown topic", () => {
      const output = { ...validNormalizationOutput(), topic: "weather" };
      expect(registry.validate("market_normalization", output)).toBeUndefined();
    });
  });

  describe("event type enum widening", () => {
    it.each([
      { topic: "crypto", eventType: "price_above" },
      { topic: "crypto", eventType: "price_below" },
      { topic: "macro", eventType: "fed_rate_decision" },
      { topic: "macro", eventType: "cpi_range" },
      { topic: "sports", eventType: "winner" },
      { topic: "sports", eventType: "total" },
      { topic: "politics", eventType: "nomination" },
      { topic: "politics", eventType: "winner" },
      { topic: "current_events", eventType: "yes_no" },
    ])("accepts eventType=%s", (override) => {
      const output = { ...validNormalizationOutput(), ...override };
      expect(registry.validate("market_normalization", output)).toBeDefined();
    });

    it("rejects an unknown event type", () => {
      const output = { ...validNormalizationOutput(), eventType: "spread" };
      expect(registry.validate("market_normalization", output)).toBeUndefined();
    });
  });

  describe("asset string widening", () => {
    it.each([
      "BTC",
      "ETH",
      "SOL",
      "Argentina vs Brazil",
      "Donald Trump (2024 US Presidential Election)",
      "some arbitrary subject string",
    ])("accepts asset=%s", (asset) => {
      const output = { ...validNormalizationOutput(), asset };
      expect(registry.validate("market_normalization", output)).toBeDefined();
    });

    it("accepts null asset", () => {
      const output = { ...validNormalizationOutput(), asset: null };
      expect(registry.validate("market_normalization", output)).toBeDefined();
    });

    it("rejects empty-string asset", () => {
      const output = { ...validNormalizationOutput(), asset: "" };
      expect(registry.validate("market_normalization", output)).toBeUndefined();
    });

    it("rejects numeric asset", () => {
      const output = { ...validNormalizationOutput(), asset: 123 };
      expect(registry.validate("market_normalization", output)).toBeUndefined();
    });
  });

  describe("describeScannerSchema", () => {
    it("includes the widened topics and event types in the prompt description", () => {
      const description = describeScannerSchema("market_normalization");
      expect(description.topic).toContain("crypto");
      expect(description.topic).toContain("macro");
      expect(description.topic).toContain("sports");
      expect(description.topic).toContain("politics");
      expect(description.topic).toContain("current_events");

      expect(description.eventType).toContain("price_above");
      expect(description.eventType).toContain("price_below");
      expect(description.eventType).toContain("fed_rate_decision");
      expect(description.eventType).toContain("cpi_range");
      expect(description.eventType).toContain("winner");
      expect(description.eventType).toContain("total");
      expect(description.eventType).toContain("nomination");
      expect(description.eventType).toContain("yes_no");
    });

    it("describes asset as a free-form string or null", () => {
      const description = describeScannerSchema("market_normalization");
      // The previous description was "BTC|ETH|null". After widening it must
      // be a generic non-empty string (or equivalent free-form description),
      // not a closed crypto-asset list.
      expect(description.asset).not.toBe("BTC|ETH|null");
      expect(description.asset).toMatch(/string/);
      expect(description.asset).toContain("null");
    });
  });
});
