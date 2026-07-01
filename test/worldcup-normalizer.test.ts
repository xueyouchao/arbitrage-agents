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

  it("handles accented team names in vs pattern (Curaçao)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-CUW",
        title: "Egypt vs Curaçao: To Advance",
      })
    );

    expect(market).toBeDefined();
    expect(market?.teamCode).toBe("egy");
    expect(market?.opponentCode).toBe("cuw");
  });

  it("handles accented team names in vs pattern (Côte d'Ivoire)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-CIV",
        title: "Côte d'Ivoire vs Ecuador: To Advance",
      })
    );

    expect(market).toBeDefined();
    expect(market?.teamCode).toBe("civ");
    expect(market?.opponentCode).toBe("ecu");
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

  it("drops exact-score markets (returns undefined)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-NEDJPN-EXACT",
        title: "Netherlands vs. Japan - Exact Score: 0-3",
      })
    );

    expect(market).toBeUndefined();
  });

  it("drops correct-score markets (returns undefined)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-NEDJPN-CORRECT",
        title: "Netherlands vs Japan - Correct Score 2-1",
      })
    );

    expect(market).toBeUndefined();
  });

  it("drops score-line pattern markets (returns undefined)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "kalshi",
        venueMarketId: "KXWCGAME-NEDJPN-SCORELINE",
        title: "Netherlands vs. Japan 1-0",
      })
    );

    expect(market).toBeUndefined();
  });

  it("does NOT drop a winner market whose rules text contains an ISO date like 2026-07-19", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-BRA-WC26",
        title: "Will Brazil win the 2026 FIFA World Cup?",
        rawResolutionText: "This market resolves based on official FIFA result. Final match: 2026-07-19.",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Winner);
    expect(market?.teamCode).toBe("bra");
  });

  it("still classifies match-winner markets with 'Winner' as Match (backward compat)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-NED-JPN-WINNER",
        title: "Netherlands vs Japan Winner?",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Match);
    expect(market?.teamCode).toBe("ned");
    expect(market?.opponentCode).toBe("jpn");
  });

  it("drops 'Other' catch-all winner markets (returns undefined)", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-WC26-OTHER",
        title: "2026 World Cup Winner - Other",
        rawResolutionText:
          "This market resolves YES if the winner of the 2026 FIFA World Cup is not France, Brazil, Argentina, Switzerland, Germany, Spain, England, Portugal, Netherlands, or Belgium.",
      })
    );

    expect(market).toBeUndefined();
  });

  it("does NOT drop a match market that mentions 'other' and 'winner' but is not the catch-all", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-WC26-OTHER-MATCH",
        title: "Will the other team beat the previous winner in the 2026 FIFA World Cup?",
        rawResolutionText: "Resolves per official FIFA results.",
      })
    );

    expect(market).toBeDefined();
  });

  it("still classifies normal team winner markets titled like 'Winner - {Team}'", () => {
    const market = classifyWorldCupMarket(
      snapshot({
        venue: "polymarket",
        venueMarketId: "PM-WC26-FRA",
        title: "2026 World Cup Winner - France",
        rawResolutionText:
          "This market resolves YES if France wins the 2026 FIFA World Cup.",
      })
    );

    expect(market).toBeDefined();
    expect(market?.marketType).toBe(WorldCupMarketType.Winner);
    expect(market?.teamCode).toBe("fra");
    expect(market?.teamResolved).toBe(true);
  });
});
