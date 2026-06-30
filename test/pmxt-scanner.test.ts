import { describe, expect, it, vi } from "vitest";
import { PmxtFetcher, PmxtFetchResult } from "../src/contexts/venues/infrastructure/pmxt-fetcher";
import { PmxtWcArbScanner } from "../src/contexts/worldcup/application/pmxtwc-arb-scanner";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";

function mockSnapshot(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KXWCGAME-TEST",
    title: "Brazil vs Argentina: To Advance",
    rawResolutionText: "FIFA World Cup 2026",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockBook(overrides: Partial<MarketBook>): MarketBook {
  return {
    marketId: "KXWCGAME-TEST",
    venue: "kalshi",
    yesAsk: 0.55,
    noAsk: 0.48,
    yesAvailableUsd: 100,
    noAvailableUsd: 100,
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockFetcher(result: PmxtFetchResult): PmxtFetcher {
  return { fetch: vi.fn().mockResolvedValue(result) } as unknown as PmxtFetcher;
}

describe("PmxtWcArbScanner", () => {
  it("finds arbitrage opportunities with matching cross-venue markets", async () => {
    const capturedAt = "2026-06-15T10:00:00Z";
    const kalshiMarket = mockSnapshot({
      venue: "kalshi",
      venueMarketId: "KXWCGAME-BRAARG",
      title: "Brazil vs Argentina: To Advance",
    });
    const polyMarket = mockSnapshot({
      venue: "polymarket",
      venueMarketId: "PM-BRA-ARG-MATCH",
      title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
    });

    const kalshiBook = mockBook({
      marketId: "KXWCGAME-BRAARG",
      venue: "kalshi",
      yesAsk: 0.50,
      noAsk: 0.55,
      yesAvailableUsd: 500,
      noAvailableUsd: 500,
      capturedAt,
    });
    const polyBook = mockBook({
      marketId: "PM-BRA-ARG-MATCH",
      venue: "polymarket",
      yesAsk: 0.65,
      noAsk: 0.38,
      yesAvailableUsd: 500,
      noAvailableUsd: 500,
      capturedAt,
    });

    const fetcher = createMockFetcher({
      capturedAt,
      kalshiMarkets: [kalshiMarket],
      polymarketMarkets: [polyMarket],
      kalshiBooks: [kalshiBook],
      polymarketBooks: [polyBook],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find({ minNetEdge: 0, noFilter: true, scanTimeUtc: capturedAt });

    expect(result.kalshiMarketCount).toBe(1);
    expect(result.polymarketMarketCount).toBe(1);
    expect(result.candidatePairs).toBeGreaterThanOrEqual(1);
    expect(result.opportunities.length).toBeGreaterThanOrEqual(1);

    const opp = result.opportunities[0];
    expect(opp.paperTradeSimulations).toHaveLength(3);
  });

  it("returns zero opportunities when markets do not match", async () => {
    const kalshiMarket = mockSnapshot({
      venue: "kalshi",
      venueMarketId: "KXWCGAME-BRA",
      title: "Brazil to win 2026 FIFA World Cup",
    });
    const polyMarket = mockSnapshot({
      venue: "polymarket",
      venueMarketId: "PM-ARG-WC",
      title: "Will Argentina win the 2026 FIFA World Cup?",
    });

    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [kalshiMarket],
      polymarketMarkets: [polyMarket],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find({ minNetEdge: 0 });

    expect(result.kalshiMarketCount).toBe(1);
    expect(result.polymarketMarketCount).toBe(1);
    expect(result.candidatePairs).toBe(0);
    expect(result.opportunities).toHaveLength(0);
  });

  it("returns timings with non-negative values", async () => {
    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [],
      polymarketMarkets: [],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find();

    expect(result.kalshiMarketCount).toBe(0);
    expect(result.polymarketMarketCount).toBe(0);
    expect(result.timings.fetchMarketsMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.filterAndPairMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.fetchOrderbooksMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.calculateMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("skips pairs missing orderbooks", async () => {
    const kalshiMarket = mockSnapshot({
      venue: "kalshi",
      venueMarketId: "KXWCGAME-BRAARG",
      title: "Brazil vs Argentina: To Advance",
    });
    const polyMarket = mockSnapshot({
      venue: "polymarket",
      venueMarketId: "PM-BRA-ARG-MATCH",
      title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
    });

    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [kalshiMarket],
      polymarketMarkets: [polyMarket],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find({ minNetEdge: 0, noFilter: true });

    expect(result.candidatePairs).toBeGreaterThanOrEqual(1);
    expect(result.opportunities).toHaveLength(0);
  });

  it("uses scanTimeUtc from options when provided", async () => {
    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [],
      polymarketMarkets: [],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find({ scanTimeUtc: "2026-06-20T12:00:00Z" });

    expect(result.scannedAt).toBe("2026-06-20T12:00:00Z");
  });

  it("uses capturedAt from fetch result when scanTimeUtc not provided", async () => {
    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [],
      polymarketMarkets: [],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    const result = await scanner.find();

    expect(result.scannedAt).toBe("2026-06-15T10:00:00Z");
  });

  it("uses clock fallback when capturedAt is empty", async () => {
    const fetcher = createMockFetcher({
      capturedAt: "",
      kalshiMarkets: [],
      polymarketMarkets: [],
      kalshiBooks: [],
      polymarketBooks: [],
    });

    const scanner = new PmxtWcArbScanner(fetcher, undefined, undefined, () => "2026-06-25T08:00:00Z");
    const result = await scanner.find();

    expect(result.scannedAt).toBe("2026-06-25T08:00:00Z");
  });

  it("filters opportunities by minNetEdge when noFilter is false", async () => {
    const kalshiMarket = mockSnapshot({
      venue: "kalshi",
      venueMarketId: "KXWCGAME-BRAARG",
      title: "Brazil vs Argentina: To Advance",
    });
    const polyMarket = mockSnapshot({
      venue: "polymarket",
      venueMarketId: "PM-BRA-ARG-MATCH",
      title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
    });

    const kalshiBook = mockBook({
      marketId: "KXWCGAME-BRAARG",
      venue: "kalshi",
      yesAsk: 0.50,
      noAsk: 0.55,
      yesAvailableUsd: 500,
      noAvailableUsd: 500,
      capturedAt: "2026-06-15T10:00:00Z",
    });
    const polyBook = mockBook({
      marketId: "PM-BRA-ARG-MATCH",
      venue: "polymarket",
      yesAsk: 0.65,
      noAsk: 0.38,
      yesAvailableUsd: 500,
      noAvailableUsd: 500,
      capturedAt: "2026-06-15T10:00:00Z",
    });

    const fetcher = createMockFetcher({
      capturedAt: "2026-06-15T10:00:00Z",
      kalshiMarkets: [kalshiMarket],
      polymarketMarkets: [polyMarket],
      kalshiBooks: [kalshiBook],
      polymarketBooks: [polyBook],
    });

    const scanner = new PmxtWcArbScanner(fetcher);
    // With a very high minNetEdge, no opportunities should pass the filter
    const result = await scanner.find({ minNetEdge: 999, noFilter: false, scanTimeUtc: "2026-06-15T10:00:00Z" });

    expect(result.opportunities).toHaveLength(0);
  });
});