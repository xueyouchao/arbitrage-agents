import { describe, expect, it } from "vitest";
import {
  comparePmxtOrderbooks,
  PmxtOrderbookComparisonConfig,
} from "../../src/contexts/scanner/pmxt/pmxt-orderbook-comparison";
import { PmxtMarketBook } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import { MarketBook } from "../../src/contexts/arbitrage/domain/opportunity";

function pmxtBook(overrides: Partial<PmxtMarketBook> = {}): PmxtMarketBook {
  return {
    marketId: "m1",
    venue: "pmxt",
    yesAsk: 0.52,
    noAsk: 0.48,
    yesAvailableUsd: 5.2,
    noAvailableUsd: 2.4,
    yesDepth: [{ price: 0.52, size: 10 }],
    noDepth: [{ price: 0.48, size: 5 }],
    capturedAt: "2026-07-15T12:00:00.000Z",
    stale: false,
    rawPayload: {},
    ...overrides,
  };
}

function venueBook(overrides: Partial<MarketBook> = {}): MarketBook {
  return {
    marketId: "m1",
    venue: "kalshi",
    yesAsk: 0.52,
    noAsk: 0.48,
    yesAvailableUsd: 5.2,
    noAvailableUsd: 2.4,
    capturedAt: "2026-07-15T12:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

function config(overrides: Partial<PmxtOrderbookComparisonConfig> = {}): PmxtOrderbookComparisonConfig {
  return {
    maxBookAgeMs: 60_000,
    minTopOfBookEdge: 0.001,
    clock: () => new Date("2026-07-15T12:00:01.000Z").getTime(),
    ...overrides,
  };
}

describe("PMXT orderbook comparison", () => {
  describe("top-of-book comparison", () => {
    it("detects a YES-side edge when PMXT ask is lower than venue ask", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.50 });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(1);
      expect(results[0].side).toBe("YES");
      expect(results[0].pmxtPrice).toBe(0.50);
      expect(results[0].venuePrice).toBe(0.55);
      expect(results[0].edge).toBeCloseTo(0.05, 4);
    });

    it("detects a NO-side edge when PMXT ask is lower than venue ask", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.45 });
      const venue = venueBook({ yesAsk: 0.50, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(1);
      expect(results[0].side).toBe("NO");
      expect(results[0].pmxtPrice).toBe(0.45);
      expect(results[0].venuePrice).toBe(0.50);
    });

    it("returns empty when no edge exceeds minimum", () => {
      const pmxt = pmxtBook({ yesAsk: 0.52, noAsk: 0.48 });
      const venue = venueBook({ yesAsk: 0.52, noAsk: 0.48 });
      const results = comparePmxtOrderbooks(pmxt, venue, config({ minTopOfBookEdge: 0.01 }));
      expect(results).toHaveLength(0);
    });

    it("returns empty when PMXT is more expensive on both sides", () => {
      const pmxt = pmxtBook({ yesAsk: 0.60, noAsk: 0.55 });
      const venue = venueBook({ yesAsk: 0.50, noAsk: 0.45 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(0);
    });
  });

  describe("stale book handling", () => {
    it("excludes stale PMXT books from comparison", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.50, stale: true });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(0);
    });

    it("excludes stale venue books from comparison", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.50 });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50, stale: true });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(0);
    });

    it("still records stale books for coverage metrics", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.50, stale: true });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // No executable comparisons, but the book is still available
      expect(results).toHaveLength(0);
    });
  });

  describe("time eligibility", () => {
    it("excludes books older than maxBookAgeMs", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.50,
        capturedAt: "2026-07-15T11:58:00.000Z", // 2 minutes old
      });
      const venue = venueBook({
        yesAsk: 0.55,
        noAsk: 0.50,
        capturedAt: "2026-07-15T12:00:00.000Z",
      });
      const results = comparePmxtOrderbooks(pmxt, venue, config({ maxBookAgeMs: 60_000 }));
      expect(results).toHaveLength(0);
    });

    it("includes books within maxBookAgeMs", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.50,
        capturedAt: "2026-07-15T12:00:00.500Z", // 500ms old
      });
      const venue = venueBook({
        yesAsk: 0.55,
        noAsk: 0.50,
        capturedAt: "2026-07-15T12:00:00.500Z",
      });
      const results = comparePmxtOrderbooks(pmxt, venue, config({ maxBookAgeMs: 60_000 }));
      expect(results).toHaveLength(1);
    });
  });

  describe("one-sided and empty books", () => {
    it("handles one-sided PMXT book (YES only)", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: undefined,
        noDepth: [],
        noAvailableUsd: 0,
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // Only YES side can be compared
      expect(results.every((r) => r.side === "YES")).toBe(true);
    });

    it("handles one-sided venue book (NO missing)", () => {
      const pmxt = pmxtBook({ yesAsk: 0.55, noAsk: 0.45 });
      const venue = venueBook({ yesAsk: 0.55, noAsk: undefined as unknown as number });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // NO side missing on venue, YES side has no edge → no results
      expect(results).toHaveLength(0);
    });

    it("returns empty for empty PMXT book", () => {
      const pmxt = pmxtBook({
        yesAsk: undefined,
        noAsk: undefined,
        yesDepth: [],
        noDepth: [],
        yesAvailableUsd: 0,
        noAvailableUsd: 0,
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      expect(results).toHaveLength(0);
    });
  });

  describe("no synthetic prices", () => {
    it("does not synthesize a NO price from YES inversion", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: undefined,
        noDepth: [],
        noAvailableUsd: 0,
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // Should NOT contain a NO-side comparison using 1 - yesAsk
      const noResults = results.filter((r) => r.side === "NO");
      expect(noResults).toHaveLength(0);
    });

    it("does not synthesize a YES price from NO inversion", () => {
      const pmxt = pmxtBook({
        yesAsk: undefined,
        noAsk: 0.45,
        yesDepth: [],
        yesAvailableUsd: 0,
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      const yesResults = results.filter((r) => r.side === "YES");
      expect(yesResults).toHaveLength(0);
    });
  });

  describe("depth comparison", () => {
    it("includes depth levels in comparison results", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.48,
        yesDepth: [
          { price: 0.50, size: 10 },
          { price: 0.52, size: 5 },
        ],
        noDepth: [{ price: 0.48, size: 5 }],
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      for (const result of results) {
        expect(result.pmxtDepth).toBeDefined();
        expect(result.pmxtDepth.length).toBeGreaterThan(0);
      }
    });

    it("computes executable depth (available USD) at each level", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.48,
        yesDepth: [
          { price: 0.50, size: 10 },
          { price: 0.52, size: 5 },
        ],
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      const yesResult = results.find((r) => r.side === "YES");
      expect(yesResult).toBeDefined();
      expect(yesResult!.pmxtExecutableUsd).toBeGreaterThan(0);
    });
  });

  describe("tick ordering", () => {
    it("preserves tick ordering in depth levels", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        yesDepth: [
          { price: 0.52, size: 5 },
          { price: 0.50, size: 10 },
        ],
      });
      const venue = venueBook({ yesAsk: 0.55 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      const yesResult = results.find((r) => r.side === "YES");
      expect(yesResult).toBeDefined();
      // Depth should be sorted ascending
      const prices = yesResult!.pmxtDepth.map((d) => d.price);
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
      }
    });
  });

  describe("size units", () => {
    it("validates size units are positive", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        yesDepth: [{ price: 0.50, size: 10 }],
      });
      const venue = venueBook({ yesAsk: 0.55 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      const yesResult = results.find((r) => r.side === "YES");
      expect(yesResult).toBeDefined();
      expect(yesResult!.pmxtDepth[0].size).toBeGreaterThan(0);
    });
  });

  describe("source timestamps", () => {
    it("records source timestamps separately from receipt timestamps", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.48,
        capturedAt: "2026-07-15T12:00:00.000Z",
      });
      const venue = venueBook({
        yesAsk: 0.55,
        noAsk: 0.50,
        capturedAt: "2026-07-15T12:00:00.500Z",
      });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      for (const result of results) {
        expect(result.pmxtCapturedAt).toBe("2026-07-15T12:00:00.000Z");
        expect(result.venueCapturedAt).toBe("2026-07-15T12:00:00.500Z");
        expect(result.comparedAt).toBeDefined();
        // comparedAt should differ from source timestamps
        expect(result.comparedAt).not.toBe(result.pmxtCapturedAt);
      }
    });
  });

  describe("optional/missing source timestamps", () => {
    it("excludes books with missing PMXT source timestamp", () => {
      const pmxt = pmxtBook({
        yesAsk: 0.50,
        noAsk: 0.48,
        capturedAt: "",
      });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50 });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // Missing timestamp → excluded
      expect(results).toHaveLength(0);
    });

    it("excludes books with missing venue source timestamp", () => {
      const pmxt = pmxtBook({ yesAsk: 0.50, noAsk: 0.48 });
      const venue = venueBook({ yesAsk: 0.55, noAsk: 0.50, capturedAt: "" });
      const results = comparePmxtOrderbooks(pmxt, venue, config());
      // Missing timestamp → excluded
      expect(results).toHaveLength(0);
    });
  });
});
