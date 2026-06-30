import { describe, expect, it } from "vitest";
import { buildWorldCupPairs } from "../src/contexts/worldcup/domain/worldcup-pair-matcher";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

function kalshiMarket(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: "KWC-BRA-26",
    title: "Brazil to win 2026 FIFA World Cup",
    rawResolutionText: "Based on FIFA official result.",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function polyMarket(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
  return {
    venue: "polymarket",
    venueMarketId: "PM-BRA-WC26",
    title: "Will Brazil win the 2026 FIFA World Cup?",
    rawResolutionText: "Resolves per official FIFA result.",
    rawPayload: {},
    capturedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildWorldCupPairs", () => {
  it("matches identical team winner markets across venues", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-BRA-26", title: "Brazil to win 2026 FIFA World Cup" }),
      polyMarket({ venueMarketId: "PM-BRA-WC26", title: "Will Brazil win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].kalshiMarket.teamCode).toBe("bra");
    expect(pairs[0].polymarketMarket.teamCode).toBe("bra");
  });

  it("matches different team name aliases", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-FRA-26", title: "France to win 2026 FIFA World Cup" }),
      polyMarket({ venueMarketId: "PM-FRA-WC26", title: "Will Les Bleus win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].kalshiMarket.teamCode).toBe("fra");
    expect(pairs[0].polymarketMarket.teamCode).toBe("fra");
  });

  it("does not match different teams", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-BRA-26", title: "Brazil to win 2026 FIFA World Cup" }),
      polyMarket({ venueMarketId: "PM-ARG-WC26", title: "Will Argentina win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs).toHaveLength(0);
  });

  it("does not match different market types", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({
        venueMarketId: "KWC-BRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
      }),
      polyMarket({
        venueMarketId: "PM-BRA-MATCH",
        title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
      }),
    ]);

    expect(pairs).toHaveLength(0);
  });

  it("matches multiple markets for the same team", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-BRA-26", title: "Brazil to win 2026 FIFA World Cup" }),
      kalshiMarket({ venueMarketId: "KWC-BRA-GROUP", title: "Will Brazil advance from Group A in the 2026 FIFA World Cup?" }),
      polyMarket({ venueMarketId: "PM-BRA-WC26", title: "Will Brazil win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].kalshiMarket.marketType).toBe("winner");
  });

  it("skips markets without team resolution", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-UNK", title: "Will Atlantis win the 2026 FIFA World Cup?" }),
      polyMarket({ venueMarketId: "PM-UNK", title: "Will Atlantis win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs).toHaveLength(0);
  });

  it("skips non-World-Cup markets", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "K-BTC", title: "Will Bitcoin reach $100k by June?", rawResolutionText: "" }),
      polyMarket({ venueMarketId: "P-BTC", title: "Will Bitcoin reach $100k by June?", rawResolutionText: "" }),
    ]);

    expect(pairs).toHaveLength(0);
  });

  it("bridges matched pairs to generic CandidatePair shape", () => {
    const pairs = buildWorldCupPairs([
      kalshiMarket({ venueMarketId: "KWC-BRA-26", title: "Brazil to win 2026 FIFA World Cup" }),
      polyMarket({ venueMarketId: "PM-BRA-WC26", title: "Will Brazil win the 2026 FIFA World Cup?" }),
    ]);

    expect(pairs[0].genericPair).toBeDefined();
    expect(pairs[0].genericPair.kalshiMarket.topic).toBe("sports");
    expect(pairs[0].genericPair.kalshiMarket.eventType).toBe("winner");
    expect(pairs[0].genericPair.polymarketMarket.topic).toBe("sports");
  });
});
