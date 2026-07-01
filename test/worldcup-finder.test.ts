import { describe, expect, it } from "vitest";
import { WorldCupArbFinder } from "../src/contexts/worldcup/application/worldcup-arb-finder";
import { VenueClient, VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";

function mockSnapshot(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KWC-TEST-001",
    title: "Will Brazil win the 2026 FIFA World Cup?",
    rawResolutionText: "Based on official FIFA result. FIFA World Cup 2026 ends July 19, 2026.",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockBook(overrides: Partial<MarketBook>): MarketBook {
  return {
    marketId: "KWC-TEST-001",
    venue: "kalshi",
    yesAsk: 0.6,
    noAsk: 0.45,
    yesAvailableUsd: 100,
    noAvailableUsd: 100,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockClient(markets: VenueMarketSnapshot[], books: MarketBook[]): VenueClient {
  return {
    listMarkets: () => Promise.resolve(markets),
    listOrderbooks: () => Promise.resolve(books),
  };
}

describe("WorldCupArbFinder", () => {
  it("finds arbitrage opportunities with matching markets", async () => {
    const kalshiMarkets = [
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KWC-BRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
      }),
    ];
    const polyMarkets = [
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "PM-BRA-WC26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
      }),
    ];

    const kalshiBooks = [
      mockBook({ marketId: "KWC-BRA-26", venue: "kalshi", yesAsk: 0.50, noAsk: 0.55, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];
    const polyBooks = [
      mockBook({ marketId: "PM-BRA-WC26", venue: "polymarket", yesAsk: 0.65, noAsk: 0.38, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];

    const finder = new WorldCupArbFinder({
      kalshiClient: createMockClient(kalshiMarkets, kalshiBooks),
      polymarketClient: createMockClient(polyMarkets, polyBooks),
    });

    const result = await finder.find({
      minNetEdge: 0,
      feeRate: 0.01,
      paperTradeNotionals: [5, 25, 100],
    });

    expect(result.kalshiMarketCount).toBe(1);
    expect(result.polymarketMarketCount).toBe(1);
    expect(result.candidatePairs).toBeGreaterThanOrEqual(1);
    expect(result.opportunities.length).toBeGreaterThanOrEqual(1);

    const opp = result.opportunities[0];
    expect(opp.pair.kalshiMarket.teamCode).toBe("bra");
    expect(opp.pair.polymarketMarket.teamCode).toBe("bra");
    expect(opp.opportunity.grossEdge).toBeGreaterThan(0);
    expect(opp.paperTradeSimulations).toHaveLength(3);
  });

  it("returns zero opportunities when markets do not match", async () => {
    const kalshiMarkets = [
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KWC-BRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
      }),
    ];
    const polyMarkets = [
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "PM-ARG-WC26",
        title: "Will Argentina win the 2026 FIFA World Cup?",
      }),
    ];

    const finder = new WorldCupArbFinder({
      kalshiClient: createMockClient(kalshiMarkets, []),
      polymarketClient: createMockClient(polyMarkets, []),
    });

    const result = await finder.find({ minNetEdge: 0 });

    expect(result.kalshiMarketCount).toBe(1);
    expect(result.polymarketMarketCount).toBe(1);
    expect(result.candidatePairs).toBe(0);
    expect(result.opportunities).toHaveLength(0);
  });

  it("handles venue API failures gracefully", async () => {
    const failingClient: VenueClient = {
      listMarkets: () => Promise.reject(new Error("Network error")),
      listOrderbooks: () => Promise.reject(new Error("Network error")),
    };
    const emptyClient: VenueClient = {
      listMarkets: () => Promise.resolve([]),
      listOrderbooks: () => Promise.resolve([]),
    };

    const finder = new WorldCupArbFinder({
      kalshiClient: failingClient,
      polymarketClient: emptyClient,
    });

    const result = await finder.find({ minNetEdge: 0 });

    // Should handle gracefully — zero markets from failing venue.
    expect(result.kalshiMarketCount).toBe(0);
    expect(result.polymarketMarketCount).toBe(0);
    expect(result.candidatePairs).toBe(0);
    expect(result.opportunities).toHaveLength(0);
  });

  // ── Issue #74: full default-path pipeline integration tests ──

  it("finds opportunities in the full default-path pipeline with realistic WC winner markets", async () => {
    // Realistic Kalshi KXWC* winner markets — venue IDs use the KXWC prefix
    // so classifyWorldCupMarket recognises them even without "World Cup" in
    // the title.
    const kalshiMarkets = [
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCWINFRA-26",
        title: "France to win 2026 FIFA World Cup",
        rawResolutionText: "Will France win the 2026 FIFA World Cup? FIFA World Cup 2026 ends July 19, 2026.",
      }),
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCWINARG-26",
        title: "Argentina to win 2026 FIFA World Cup",
        rawResolutionText: "Will Argentina win the 2026 FIFA World Cup? FIFA World Cup 2026 ends July 19, 2026.",
      }),
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCWINBRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
        rawResolutionText: "Will Brazil win the 2026 FIFA World Cup? FIFA World Cup 2026 ends July 19, 2026.",
      }),
    ];
    // Realistic Polymarket WC winner markets — rawResolutionText includes the
    // "FIFA World Cup 2026" prefix that injectWorldCupTag would add in the
    // real venue client.
    const polyMarkets = [
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-fra-wc26",
        title: "Will France win the 2026 FIFA World Cup?",
        rawResolutionText: "FIFA World Cup 2026\nWill France win the 2026 FIFA World Cup?",
      }),
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-arg-wc26",
        title: "Will Argentina win the 2026 FIFA World Cup?",
        rawResolutionText: "FIFA World Cup 2026\nWill Argentina win the 2026 FIFA World Cup?",
      }),
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-bra-wc26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
        rawResolutionText: "FIFA World Cup 2026\nWill Brazil win the 2026 FIFA World Cup?",
      }),
    ];

    const kalshiBooks = [
      mockBook({ marketId: "KXWCWINFRA-26", venue: "kalshi", yesAsk: 0.15, noAsk: 0.88, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "KXWCWINARG-26", venue: "kalshi", yesAsk: 0.18, noAsk: 0.85, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "KXWCWINBRA-26", venue: "kalshi", yesAsk: 0.22, noAsk: 0.80, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];
    const polyBooks = [
      mockBook({ marketId: "cond-fra-wc26", venue: "polymarket", yesAsk: 0.20, noAsk: 0.82, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "cond-arg-wc26", venue: "polymarket", yesAsk: 0.25, noAsk: 0.78, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "cond-bra-wc26", venue: "polymarket", yesAsk: 0.28, noAsk: 0.75, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];

    const finder = new WorldCupArbFinder({
      kalshiClient: createMockClient(kalshiMarkets, kalshiBooks),
      polymarketClient: createMockClient(polyMarkets, polyBooks),
    });

    const result = await finder.find({
      minNetEdge: 0,
      feeRate: 0.01,
      paperTradeNotionals: [5, 25, 100],
    });

    // Pipeline should classify all 3 markets on each venue as WC winner markets.
    expect(result.kalshiMarketCount).toBe(3);
    expect(result.polymarketMarketCount).toBe(3);
    expect(result.candidatePairs).toBeGreaterThanOrEqual(3);
    // At least one opportunity should exist (Kalshi YES cheaper than Poly YES).
    expect(result.opportunities.length).toBeGreaterThanOrEqual(1);

    // Verify the teams found match what we provided.
    const teams = result.opportunities.map((o) => o.pair.kalshiMarket.teamCode).sort();
    expect(teams).toContain("bra");
    expect(teams).toContain("fra");
    expect(teams).toContain("arg");
  });

  it("does not produce false-positive opportunities from exact-score markets in the full pipeline", async () => {
    // Exact-score Kalshi market with a KXWC prefix — the isExactScoreMarket
    // guard in classifyWorldCupMarket should drop it before pairing.
    const kalshiMarkets = [
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCScoreFRAARG-0-3",
        title: "France vs Argentina: Exact Score 0-3",
        rawResolutionText: "FIFA World Cup 2026. What will the exact score be?",
      }),
      // Include one legitimate winner market to prove the pipeline still works.
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCWINBRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
        rawResolutionText: "Will Brazil win the 2026 FIFA World Cup? FIFA World Cup 2026 ends July 19, 2026.",
      }),
    ];
    const polyMarkets = [
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-score-fra-arg",
        title: "France vs Argentina: Correct Score 0 - 3",
        rawResolutionText: "FIFA World Cup 2026\nWhat will the exact score be?",
      }),
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-bra-wc26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
        rawResolutionText: "FIFA World Cup 2026\nWill Brazil win the 2026 FIFA World Cup?",
      }),
    ];

    const kalshiBooks = [
      mockBook({ marketId: "KXWCScoreFRAARG-0-3", venue: "kalshi", yesAsk: 0.05, noAsk: 0.95, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "KXWCWINBRA-26", venue: "kalshi", yesAsk: 0.22, noAsk: 0.80, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];
    const polyBooks = [
      mockBook({ marketId: "cond-score-fra-arg", venue: "polymarket", yesAsk: 0.10, noAsk: 0.90, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "cond-bra-wc26", venue: "polymarket", yesAsk: 0.28, noAsk: 0.75, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];

    const finder = new WorldCupArbFinder({
      kalshiClient: createMockClient(kalshiMarkets, kalshiBooks),
      polymarketClient: createMockClient(polyMarkets, polyBooks),
    });

    const result = await finder.find({ minNetEdge: 0 });

    // Both exact-score markets should be dropped — only the Brazil winner
    // pair should remain.
    expect(result.candidatePairs).toBe(1);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].pair.kalshiMarket.teamCode).toBe("bra");
  });

  it("does not produce false-positive opportunities from Other/catch-all markets in the full pipeline", async () => {
    // Polymarket "World Cup Winner - Other" catch-all market — lists excluded
    // teams in the description. isOtherCatchAllMarket should drop it.
    const kalshiMarkets = [
      mockSnapshot({
        venue: "kalshi",
        venueMarketId: "KXWCWINBRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
        rawResolutionText: "Will Brazil win the 2026 FIFA World Cup? FIFA World Cup 2026 ends July 19, 2026.",
      }),
    ];
    const polyMarkets = [
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-other-wc26",
        title: "2026 World Cup Winner - Other",
        rawResolutionText: "FIFA World Cup 2026\nWill a team other than France, Brazil, Argentina, Switzerland win?",
      }),
      mockSnapshot({
        venue: "polymarket",
        venueMarketId: "cond-bra-wc26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
        rawResolutionText: "FIFA World Cup 2026\nWill Brazil win the 2026 FIFA World Cup?",
      }),
    ];

    const kalshiBooks = [
      mockBook({ marketId: "KXWCWINBRA-26", venue: "kalshi", yesAsk: 0.22, noAsk: 0.80, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];
    const polyBooks = [
      mockBook({ marketId: "cond-other-wc26", venue: "polymarket", yesAsk: 0.50, noAsk: 0.50, yesAvailableUsd: 500, noAvailableUsd: 500 }),
      mockBook({ marketId: "cond-bra-wc26", venue: "polymarket", yesAsk: 0.28, noAsk: 0.75, yesAvailableUsd: 500, noAvailableUsd: 500 }),
    ];

    const finder = new WorldCupArbFinder({
      kalshiClient: createMockClient(kalshiMarkets, kalshiBooks),
      polymarketClient: createMockClient(polyMarkets, polyBooks),
    });

    const result = await finder.find({ minNetEdge: 0 });

    // The "Other" catch-all market should be dropped — only the Brazil pair
    // should remain.
    expect(result.candidatePairs).toBe(1);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].pair.polymarketMarket.venueMarketId).toBe("cond-bra-wc26");
  });
});
