import { describe, expect, it } from "vitest";
import { CandidatePairGenerator } from "../src/contexts/matching/domain/candidate-pair-generator";
import { MarketNormalizer } from "../src/contexts/matching/domain/market-normalizer";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

function snapshot(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KXBTC-100K",
    title: "Will Bitcoin be above $100,000 on Jan 1, 2026?",
    rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z",
    rawPayload: {},
    capturedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("MarketNormalizer", () => {
  it("normalizes clear BTC price-level markets", () => {
    const market = new MarketNormalizer().normalize(snapshot({}));

    expect(market).toMatchObject({
      venue: "kalshi",
      venueMarketId: "KXBTC-100K",
      topic: "crypto",
      eventType: "price_above",
      asset: "BTC",
      threshold: 100000,
      operator: ">",
      payoffType: "at_time",
      resolutionSource: "Coinbase BTC/USD",
      deadline: "2026-01-01T00:00:00.000Z",
    });
    expect(market.ambiguityFlags).toEqual([]);
  });

  it("parses Kalshi crypto daily time-of-day (4pm EDT) into the deadline", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Ethereum price at Jul 9, 2026 at 4pm EDT?",
        rawResolutionText:
          "If the simple average of the sixty seconds of CF Benchmarks' Ethereum Real-Time Index before 4 PM EDT is above 999.99 at 4 PM EDT on Jul 9, 2026, then the market resolves to Yes.",
      })
    );

    expect(market.deadline).toBe("2026-07-09T20:00:00.000Z");
    expect(market.ambiguityFlags).not.toContain("deadline_missing");
  });

  it("flags ambiguous crypto markets instead of treating them as safe", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({ title: "Will ETH touch $5,000 at any point next week?", rawResolutionText: "Source unclear" })
    );

    expect(market.asset).toBe("ETH");
    expect(market.threshold).toBe(5000);
    expect(market.payoffType).toBe("any_time_before");
    expect(market.ambiguityFlags).toContain("resolution_source_missing");
  });

  it("prefers explicit dollar thresholds over earlier date numbers", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({ title: "Will Bitcoin on Jan 1, 2026 be above $100,000?" })
    );

    expect(market.threshold).toBe(100000);
  });

  // -------------------------------------------------------------------------
  // Sports (Issue #1 production samples)
  // -------------------------------------------------------------------------

  it("normalizes sports total markets", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-ARG-BRA-TOTAL",
        title: "Will Argentina vs Brazil have over 2.5 goals?",
        rawResolutionText: "Resolves based on the official match result.",
      })
    );

    expect(market.topic).toBe("sports");
    expect(market.eventType).toBe("total");
    expect(market.asset).toBe("argentina vs brazil");
    expect(market.threshold).toBe(2.5);
    expect(market.operator).toBe(">");
    expect(market.payoffType).toBe("at_time");
    expect(market.resolutionSource).toBe("official sports result");
  });

  // -------------------------------------------------------------------------
  // Politics
  // -------------------------------------------------------------------------

  it("normalizes US presidential election winner markets", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-TRUMP-2024",
        title: "Will Donald Trump win the 2024 US Presidential Election?",
        rawResolutionText: "Resolves according to official election result.",
      })
    );

    expect(market.topic).toBe("politics");
    expect(market.eventType).toBe("winner");
    expect(market.asset).toContain("donald trump");
    expect(market.deadline).toBe("2024-11-05T00:00:00.000Z");
    expect(market.resolutionSource).toBe("official election result");
    expect(market.ambiguityFlags).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Current events
  // -------------------------------------------------------------------------

  it("normalizes generic current-event yes/no markets", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-X-HAPPEN",
        title: "Will X happen by December 31, 2026?",
        rawResolutionText: "Resolves based on publicly available information.",
      })
    );

    expect(market.topic).toBe("current_events");
    expect(market.eventType).toBe("yes_no");
    expect(market.asset).toBe("x");
    expect(market.deadline).toBe("2026-12-31T00:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // Macro thresholds (Issue #53)
  // -------------------------------------------------------------------------

  it("does not treat years as macro thresholds", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-CPI-BETWEEN-2024-2025",
        title: "Will CPI be between 2024 and 2025 levels?",
        rawResolutionText: "Resolves based on Bureau of Labor Statistics CPI report.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBeUndefined();
  });

  it("parses legitimate macro percentage thresholds", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-CPI-ABOVE-3-5",
        title: "Will CPI be above 3.5% this year?",
        rawResolutionText: "Resolves based on Bureau of Labor Statistics CPI report.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBe(3.5);
    expect(market.operator).toBe(">");
  });

  it("parses legitimate macro thresholds without a percent sign", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-CPI-BELOW-2-5",
        title: "Will CPI be below 2.5 next month?",
        rawResolutionText: "Resolves based on Bureau of Labor Statistics CPI report.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBe(2.5);
    expect(market.operator).toBe("<");
  });

  it("parses macro basis-point thresholds", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-FED-25BPS",
        title: "Will the Fed funds rate be above 25 bps?",
        rawResolutionText: "Resolves based on Federal Reserve policy announcement.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBe(25);
  });

  it("accepts year-like numbers when an explicit unit suffix is present", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-GDP-2024",
        title: "Will GDP be above 2024 points?",
        rawResolutionText: "Resolves based on Bureau of Economic Analysis GDP report.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBe(2024);
  });

  it("rejects year-like numbers in macro between-ranges without a unit", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-CPI-BETWEEN-YEARS",
        title: "Will CPI be between 2023 and 2025?",
        rawResolutionText: "Resolves based on Bureau of Labor Statistics CPI report.",
      })
    );

    expect(market.topic).toBe("macro");
    expect(market.threshold).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Deadline parser: resolution keywords vs event dates (issue #50)
  // -------------------------------------------------------------------------

  it("prefers resolution keyword dates over generic on dates", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will the summit happen on November 5, 2024?",
        rawResolutionText:
          "This market resolves by December 31, 2024 based on official results.",
      })
    );

    expect(market.deadline).toBe("2024-12-31T00:00:00.000Z");
  });

  it("recognizes 'resolves on' as a resolution keyword date", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will the event occur on March 15, 2026?",
        rawResolutionText: "This market resolves on December 31, 2026.",
      })
    );

    expect(market.deadline).toBe("2026-12-31T00:00:00.000Z");
  });

  it("recognizes 'expires' as a resolution keyword date", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will the event occur on March 15, 2026?",
        rawResolutionText: "This market expires on December 31, 2026.",
      })
    );

    expect(market.deadline).toBe("2026-12-31T00:00:00.000Z");
  });

  it("prefers the latest date when multiple resolution dates are present", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will X happen before March 15, 2026?",
        rawResolutionText:
          "Interim review by June 30, 2026. Final resolution by December 31, 2026.",
      })
    );

    expect(market.deadline).toBe("2026-12-31T00:00:00.000Z");
  });

  it("picks the latest generic date when no resolution keywords are present", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Event occurs on March 15, 2026 and again on November 5, 2026",
        rawResolutionText: "Details posted on September 1, 2026.",
      })
    );

    expect(market.deadline).toBe("2026-11-05T00:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // Cross-venue candidate generation
  // -------------------------------------------------------------------------

  it("produces a candidate pair for equivalent Kalshi/Polymarket sports winner markets", () => {
    const normalizer = new MarketNormalizer();
    const kalshi = normalizer.normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-CHIEFS-SB",
        title: "Will the Chiefs win Super Bowl LX?",
        rawResolutionText: "Resolves according to official NFL result on February 8, 2026.",
      })
    );
    const polymarket = normalizer.normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-CHIEFS-SB",
        title: "Will the Chiefs win Super Bowl LX?",
        rawResolutionText: "Resolves according to official NFL result on February 8, 2026.",
      })
    );

    const pairs = new CandidatePairGenerator().generate([kalshi, polymarket]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("kalshi:KX-CHIEFS-SB:polymarket:PM-CHIEFS-SB");
    expect(pairs[0].kalshiMarket.topic).toBe("sports");
    expect(pairs[0].polymarketMarket.topic).toBe("sports");
    expect(pairs[0].reasons).toContain("same_asset");
  });
  // -------------------------------------------------------------------------
  // Issue #49: invalid ISO dates must not throw RangeError from toISOString
  // -------------------------------------------------------------------------

  it("returns undefined deadline for syntactically valid but semantically invalid ISO dates", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves using Coinbase BTC/USD at 0000-00-00T00:00:00Z"
      })
    );

    expect(market.deadline).toBeUndefined();
    expect(market.ambiguityFlags).toContain("deadline_missing");
  });

  it("returns undefined deadline for invalid Jan-date combinations", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin on Jan 32, 2026 be above $100,000?",
        rawResolutionText: "Source unclear"
      })
    );

    expect(market.deadline).toBeUndefined();
    expect(market.ambiguityFlags).toContain("deadline_missing");
  });

  it("returns undefined deadline for out-of-range ISO month", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves at 2026-13-01T00:00:00Z"
      })
    );

    expect(market.deadline).toBeUndefined();
    expect(market.ambiguityFlags).toContain("deadline_missing");
  });

  it("returns undefined deadline for out-of-range ISO day", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves at 2026-01-32T00:00:00Z"
      })
    );

    expect(market.deadline).toBeUndefined();
    expect(market.ambiguityFlags).toContain("deadline_missing");
  });

  it("returns undefined deadline for out-of-range ISO hour", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves at 2026-01-01T25:00:00Z"
      })
    );

    expect(market.deadline).toBeUndefined();
    expect(market.ambiguityFlags).toContain("deadline_missing");
  });

  it("returns correct ISO deadline for valid timestamps", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z"
      })
    );

    expect(market.deadline).toBe("2026-01-01T00:00:00.000Z");
    expect(market.timezone).toBe("UTC");
    expect(market.ambiguityFlags).not.toContain("deadline_missing");
  });

  it("extractEventName handles 'Who will win the 20XX' questions", () => {
    // The "Who will win the 2026 Super Bowl?" -> extractEventName returns "2026 super bowl"
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-2026-SUPER-BOWL",
        title: "Who will win the 2026 Super Bowl?",
        rawResolutionText: "Resolves based on official NFL result",
      })
    );
    expect(market.asset).toBe("2026 super bowl");
  });
});
