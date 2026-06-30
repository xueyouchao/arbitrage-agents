import { describe, expect, it } from "vitest";
import { classifyWorldCupMarket, isWorldCup2026, WorldCupMarketType } from "../src/contexts/worldcup/domain/worldcup-normalizer";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

function snapshot(overrides: Partial<VenueMarketSnapshot>): VenueMarketSnapshot {
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

describe("isWorldCup2026", () => {
  it("matches standard references", () => {
    expect(isWorldCup2026("2026 Fifa World Cup")).toBe(true);
    expect(isWorldCup2026("world cup 2026 final")).toBe(true);
  });

  it("matches compact references", () => {
    expect(isWorldCup2026("wc2026 winner")).toBe(true);
    expect(isWorldCup2026("fifa world cup 2026")).toBe(true);
  });

  it("rejects other tournaments", () => {
    expect(isWorldCup2026("2022 FIFA World Cup")).toBe(false);
    expect(isWorldCup2026("UEFA Champions League 2026")).toBe(false);
    expect(isWorldCup2026("Bitcoin price above 100000")).toBe(false);
  });
});

describe("World Cup normalizer", () => {
  it("classifies Polymarket-style winner questions", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-BRA-WC26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
        rawResolutionText: "This market resolves based on official FIFA result.",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Winner);
    expect(market?.teamCode).toBe("bra");
    expect(market?.teamResolved).toBe(true);
  });

  it("classifies Kalshi-style winner questions", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KWC-BRA-26",
        title: "Brazil to win 2026 FIFA World Cup",
        rawResolutionText: "Resolves per FIFA official results. FIFA 2026 World Cup final July 19.",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Winner);
    expect(market?.teamCode).toBe("bra");
    expect(market?.teamResolved).toBe(true);
  });

  it("resolves team aliases across naming conventions", () => {
    const tests = [
      { title: "Will United States win the 2026 FIFA World Cup?", expected: "usa" },
      { title: "Will France win the 2026 FIFA World Cup?", expected: "fra" },
      { title: "Will Les Bleus win the 2026 FIFA World Cup?", expected: "fra" },
      { title: "Will Argentina win the 2026 FIFA World Cup?", expected: "arg" },
      { title: "Will Canarinho win the 2026 FIFA World Cup?", expected: "bra" },
    ];

    for (const { title, expected } of tests) {
      const market = classifyWorldCupMarket(snapshot({ title }));
      expect(market?.teamCode, `Failed for title: ${title}`).toBe(expected);
      expect(market?.teamResolved, `teamResolved should be true for: ${title}`).toBe(true);
    }
  });

  it("classifies match markets", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        title: "Will Brazil beat Argentina in the 2026 FIFA World Cup?",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Match);
    expect(market?.teamCode).toBe("bra");
    expect(market?.opponentCode).toBe("arg");
  });

  it("extracts opponent from Kalshi-style 'Team vs Team: To Advance' titles", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-TEST",
        title: "Argentina vs Cape Verde: To Advance",
      })
    );

    expect(market).toBeDefined();
    // The "vs" keyword classifies as Match, even with "To Advance" suffix.
    expect(market?.marketType).toBe(WorldCupMarketType.Match);
    expect(market?.teamCode).toBe("arg");
    expect(market?.opponentCode).toBe("cpv");
  });

  it("handles multi-word opponent names with colon terminator", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-TEST2",
        title: "Brazil vs Saudi Arabia: To Advance",
      })
    );

    expect(market).toBeDefined();
    expect(market?.teamCode).toBe("bra");
    expect(market?.opponentCode).toBe("ksa");
  });

  it("returns undefined for non-World-Cup markets", () => {
    expect(classifyWorldCupMarket(snapshot({ title: "Will Bitcoin reach $100k?", rawResolutionText: "" }))).toBeUndefined();
    expect(classifyWorldCupMarket(snapshot({ title: "Will it rain tomorrow?", rawResolutionText: "2026 weather forecast" }))).toBeUndefined();
  });

  it("extracts threshold for goal-based markets", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        title: "Will Brazil score over 3 goals in the 2026 FIFA World Cup?",
      })
    );

    expect(market?.threshold).toBe(3);
  });

  it("extracts group name for advance markets", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        title: "Will Brazil advance from Group A in the 2026 FIFA World Cup?",
      })
    );

    expect(market?.marketType).toBe(WorldCupMarketType.Advance);
    expect(market?.groupName).toBe("A");
  });
});
