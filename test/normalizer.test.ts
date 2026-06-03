import { describe, expect, it } from "vitest";
import { CryptoMarketNormalizer } from "../src/contexts/matching/domain/crypto-market-normalizer";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

function snapshot(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KXBTC-100K",
    title: "Will Bitcoin be above $100,000 on Jan 1, 2026?",
    rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z",
    rawPayload: {},
    capturedAt: "2026-06-03T00:00:00.000Z",
    ...overrides
  };
}

describe("CryptoMarketNormalizer", () => {
  it("normalizes clear BTC price-level markets", () => {
    const market = new CryptoMarketNormalizer().normalize(snapshot({}));

    expect(market).toMatchObject({
      venue: "kalshi",
      venueMarketId: "KXBTC-100K",
      topic: "crypto",
      eventType: "price_above",
      asset: "BTC",
      threshold: 100000,
      operator: ">",
      payoffType: "at_time",
      resolutionSource: "Coinbase BTC/USD"
    });
    expect(market.ambiguityFlags).toEqual([]);
  });

  it("flags ambiguous crypto markets instead of treating them as safe", () => {
    const market = new CryptoMarketNormalizer().normalize(
      snapshot({ title: "Will ETH touch $5,000 at any point next week?", rawResolutionText: "Source unclear" })
    );

    expect(market.asset).toBe("ETH");
    expect(market.threshold).toBe(5000);
    expect(market.payoffType).toBe("any_time_before");
    expect(market.ambiguityFlags).toContain("resolution_source_missing");
  });
  it("prefers explicit dollar thresholds over earlier date numbers", () => {
    const market = new CryptoMarketNormalizer().normalize(
      snapshot({ title: "Will Bitcoin on Jan 1, 2026 be above $100,000?" })
    );

    expect(market.threshold).toBe(100000);
  });

});
