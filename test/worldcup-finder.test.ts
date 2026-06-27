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
});
