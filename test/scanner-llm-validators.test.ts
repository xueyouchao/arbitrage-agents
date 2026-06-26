import { describe, it, expect } from "vitest";
import {
  marketNormalizationSchema,
  describeScannerSchema,
  SCANNER_TOPICS,
  SCANNER_EVENT_TYPES
} from "../src/contexts/llm/scanner-llm-validators";

const validBase = {
  topic: "crypto",
  eventType: "price_above",
  asset: "BTC",
  threshold: 100000,
  operator: ">",
  deadline: null,
  timezone: null,
  resolutionSource: null,
  payoffType: "at_time",
  confidence: 0.9,
  ambiguityFlags: []
};

function parse(input: Record<string, unknown>) {
  return marketNormalizationSchema().safeParse(input);
}

describe("marketNormalizationSchema — new topics/assets/eventTypes", () => {
  it("accepts a sports market (topic=sports, eventType=winner, asset=ghana)", () => {
    const result = parse({ ...validBase, topic: "sports", eventType: "winner", asset: "ghana" });
    expect(result.success).toBe(true);
  });

  it("accepts a politics market (topic=politics, eventType=nomination, asset=arbitrary string)", () => {
    const result = parse({
      ...validBase,
      topic: "politics",
      eventType: "nomination",
      asset: "Donald Trump (2024 US Presidential Election)"
    });
    expect(result.success).toBe(true);
  });

  it("accepts a current_events market (topic=current_events, eventType=yes_no, asset=some event)", () => {
    const result = parse({ ...validBase, topic: "current_events", eventType: "yes_no", asset: "some event" });
    expect(result.success).toBe(true);
  });

  it("still accepts crypto markets (topic=crypto, eventType=price_above, asset=BTC)", () => {
    const result = parse({ ...validBase, topic: "crypto", eventType: "price_above", asset: "BTC" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid topics (e.g. unknown_topic)", () => {
    const result = parse({ ...validBase, topic: "unknown_topic" });
    expect(result.success).toBe(false);
  });

  it("accepts null asset", () => {
    const result = parse({ ...validBase, asset: null });
    expect(result.success).toBe(true);
  });

  it("rejects empty-string asset", () => {
    const result = parse({ ...validBase, asset: "" });
    expect(result.success).toBe(false);
  });

  it("exports SCANNER_TOPICS with the new topics", () => {
    expect([...SCANNER_TOPICS]).toEqual(
      expect.arrayContaining(["crypto", "macro", "sports", "politics", "current_events"])
    );
  });

  it("exports SCANNER_EVENT_TYPES with the new event types", () => {
    expect([...SCANNER_EVENT_TYPES]).toEqual(
      expect.arrayContaining([
        "price_above", "price_below", "fed_rate_decision", "cpi_range",
        "winner", "total", "nomination", "yes_no"
      ])
    );
  });
});

describe("describeScannerSchema('market_normalization')", () => {
  const desc = describeScannerSchema("market_normalization");

  it("includes 'sports' in the topic description", () => {
    expect(desc.topic).toContain("sports");
  });

  it("describes asset as 'non-empty string|null'", () => {
    expect(desc.asset).toBe("non-empty string|null");
  });

  it("includes 'winner' in the eventType description", () => {
    expect(desc.eventType).toContain("winner");
  });
});