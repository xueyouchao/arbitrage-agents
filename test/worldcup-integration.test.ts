import { describe, expect, it } from "vitest";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { classifyWorldCupMarket } from "../src/contexts/worldcup/domain/worldcup-normalizer";
import { buildWorldCupPairs } from "../src/contexts/worldcup/domain/worldcup-pair-matcher";
import { classifyWorldCupPair } from "../src/contexts/worldcup/domain/worldcup-equivalence-policy";

/** Realistic Kalshi-style World Cup winner market (from production data). */
function kalshiSnapshot(overrides: Partial<VenueMarketSnapshot> = {}): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KWC-BRA-2026",
    title: "Brazil to win the 2026 FIFA World Cup?",
    rawResolutionText: "Resolves to yes if Brazil wins the 2026 FIFA World Cup. Resolution based on official FIFA result.",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Realistic Polymarket-style World Cup winner market. */
function polySnapshot(overrides: Partial<VenueMarketSnapshot> = {}): VenueMarketSnapshot {
  return {
    venue: "polymarket",
    venueMarketId: "0xabc123def456",
    title: "Will Brazil win the 2026 FIFA World Cup?",
    rawResolutionText: "This market resolves to yes if Brazil wins the 2026 FIFA World Cup. Resolution is based on official FIFA result.",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("World Cup arbitrage integration (end-to-end)", () => {
  it("normalizes the same team from both venues to the same canonical code", () => {
    const kalshi = classifyWorldCupMarket(kalshiSnapshot({
      title: "Will Brazil win the 2026 FIFA World Cup?",
    }));
    const poly = classifyWorldCupMarket(polySnapshot({
      title: "Brazil to win the 2026 FIFA World Cup",
    }));

    expect(kalshi?.teamCode).toBe("bra");
    expect(poly?.teamCode).toBe("bra");
    expect(kalshi?.tournamentYear).toBe("2026");
    expect(poly?.tournamentYear).toBe("2026");
  });

  it("matches cross-venue pairs where only team aliases differ", () => {
    const kalshiBrazil = kalshiSnapshot({
      venueMarketId: "KWC-BRA",
      title: "Will Brazil win the 2026 FIFA World Cup?",
    });
    const polyBrazil = polySnapshot({
      venueMarketId: "PM-BRAZIL",
      title: "Will the Brazilian National Team win the 2026 FIFA World Cup?",
    });

    const pairs = buildWorldCupPairs([kalshiBrazil, polyBrazil]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].kalshiMarket.teamCode).toBe("bra");
    expect(pairs[0].polymarketMarket.teamCode).toBe("bra");
  });

  it("does NOT produce false-positive matches between different teams", () => {
    const kalshiBrazil = kalshiSnapshot({
      venueMarketId: "KWC-BRA",
      title: "Will Brazil win the 2026 FIFA World Cup?",
    });
    const polyArgentina = polySnapshot({
      venueMarketId: "PM-ARG",
      title: "Will Argentina win the 2026 FIFA World Cup?",
    });

    const pairs = buildWorldCupPairs([kalshiBrazil, polyArgentina]);

    expect(pairs).toHaveLength(0);
  });

  it("classifies tradable pairs as Class A and rejects mismatched teams", () => {
    const kalshiBrazil = kalshiSnapshot({
      venueMarketId: "KWC-BRA",
      title: "Brazil to win 2026 FIFA World Cup",
    });
    const polyBrazil = polySnapshot({
      venueMarketId: "PM-BRA",
      title: "Will Brazil win the 2026 FIFA World Cup?",
    });

    const pairs = buildWorldCupPairs([kalshiBrazil, polyBrazil]);
    expect(pairs).toHaveLength(1);

    const decision = classifyWorldCupPair(pairs[0]);
    expect(decision.equivalenceClass).toBe("A");
    expect(decision.decision).toBe("tradable");
  });

  it("rejects pairs with different market types (winner vs match)", () => {
    const kalshi = kalshiSnapshot({
      venueMarketId: "KWC-MATCH",
      title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
    });
    const poly = polySnapshot({
      venueMarketId: "PM-WINNER",
      title: "Will Brazil win the 2026 FIFA World Cup?",
    });

    const pairs = buildWorldCupPairs([kalshi, poly]);
    expect(pairs).toHaveLength(0); // different market types → different buckets
  });

  it("handles multiple teams in a single scan", () => {
    const markets = [
      kalshiSnapshot({ venueMarketId: "K-BRA", title: "Brazil to win 2026 FIFA World Cup" }),
      kalshiSnapshot({ venueMarketId: "K-ARG", title: "Argentina to win 2026 FIFA World Cup" }),
      kalshiSnapshot({ venueMarketId: "K-FRA", title: "France to win 2026 FIFA World Cup" }),
      polySnapshot({ venueMarketId: "P-BRA", title: "Will Brazil win the 2026 FIFA World Cup?" }),
      polySnapshot({ venueMarketId: "P-ARG", title: "Will Argentina win the 2026 FIFA World Cup?" }),
      polySnapshot({ venueMarketId: "P-FRA", title: "Will France win the 2026 FIFA World Cup?" }),
      // A decoy that doesn't match
      polySnapshot({ venueMarketId: "P-NED", title: "Will Netherlands win the 2026 FIFA World Cup?" }),
    ];

    const pairs = buildWorldCupPairs(markets);

    // 3 matches: BRA, ARG, FRA. No NED on Kalshi side.
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => p.kalshiMarket.teamCode).sort()).toEqual(["arg", "bra", "fra"]);
  });

  it("classifies nicknames correctly across venues (Les Bleus / France)", () => {
    const kalshi = kalshiSnapshot({
      venueMarketId: "K-FRA",
      title: "Will France win the 2026 FIFA World Cup?",
    });
    const poly = polySnapshot({
      venueMarketId: "P-FRA",
      title: "Will Les Bleus win the 2026 FIFA World Cup?",
    });

    const pairs = buildWorldCupPairs([kalshi, poly]);
    expect(pairs).toHaveLength(1);

    const decision = classifyWorldCupPair(pairs[0]);
    expect(decision.equivalenceClass).toBe("A");
  });

  it("bridges WC pair to generic CandidatePair so OpportunityCalculator is compatible", () => {
    const kalshi = kalshiSnapshot({ venueMarketId: "K-BRA", title: "Brazil to win 2026 FIFA World Cup" });
    const poly = polySnapshot({ venueMarketId: "P-BRA", title: "Will Brazil win the 2026 FIFA World Cup?" });

    const pairs = buildWorldCupPairs([kalshi, poly]);
    expect(pairs).toHaveLength(1);

    const g = pairs[0].genericPair;
    expect(g.kalshiMarket.topic).toBe("sports");
    expect(g.kalshiMarket.eventType).toBe("winner");
    expect(g.kalshiMarket.venue).toBe("kalshi");
    expect(g.polymarketMarket.venue).toBe("polymarket");
    expect(g.kalshiMarket.resolutionSource).toBeTruthy();
    expect(g.polymarketMarket.resolutionSource).toBeTruthy();
  });
});
