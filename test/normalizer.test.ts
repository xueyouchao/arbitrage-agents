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

  it("normalizes Polymarket-style World Cup winner markets", () => {
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-GHANA-WC26",
        title: "Will Ghana win the 2026 FIFA World Cup?",
        rawResolutionText:
          "This market will resolve to 'Yes' if Ghana wins the 2026 FIFA World Cup. It will resolve to 'No' if any other team wins. Resolution will be based on official FIFA result.",
      })
    );

    expect(market.topic).toBe("sports");
    expect(market.eventType).toBe("winner");
    expect(market.asset).toContain("ghana");
    expect(market.deadline).toBe("2026-07-19T00:00:00.000Z");
    expect(market.resolutionSource).toBe("official FIFA result");
    expect(market.ambiguityFlags).toEqual([]);
  });

  it("normalizes Kalshi-style World Cup winner markets from outcome labels", () => {
    // Kalshi sometimes exposes comma-separated outcome labels in the title.
    // The meaningful market text is still the first meaningful question part.
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-MEXICO-WC26",
        title: "yes Tie,yes Mexico,yes Morocco,Will Mexico win the 2026 FIFA World Cup?",
        rawResolutionText: "Resolves according to official FIFA result.",
      })
    );

    expect(market.topic).toBe("sports");
    expect(market.eventType).toBe("winner");
    expect(market.asset).toContain("mexico");
    expect(market.deadline).toBe("2026-07-19T00:00:00.000Z");
    expect(market.resolutionSource).toBe("official FIFA result");
    expect(market.ambiguityFlags).toEqual([]);
  });

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
  // Cross-venue candidate generation
  // -------------------------------------------------------------------------

  it("produces a candidate pair for equivalent Kalshi/Polymarket World Cup winner markets", () => {
    const normalizer = new MarketNormalizer();
    const kalshi = normalizer.normalize(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KX-MEXICO-WC26",
        title: "Will Mexico win the 2026 FIFA World Cup?",
        rawResolutionText: "Resolves according to official FIFA result.",
      })
    );
    const polymarket = normalizer.normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-MEXICO-WC26",
        title: "Will Mexico win the 2026 FIFA World Cup?",
        rawResolutionText: "Resolves according to official FIFA result.",
      })
    );

    const pairs = new CandidatePairGenerator().generate([kalshi, polymarket]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("kalshi:KX-MEXICO-WC26:polymarket:PM-MEXICO-WC26");
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
    // The "Who will win the 2026 FIFA World Cup?" -> extractEventName returns "2026 fifa world cup"
    const market = new MarketNormalizer().normalize(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-2026-WORLD-CUP-WINNER",
        title: "Who will win the 2026 FIFA World Cup?",
        rawResolutionText: "Resolves based on official FIFA result",
      })
    );
    expect(market.asset).toBe("2026 fifa world cup");
  });
});
