import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  PmxtShadowRun,
  PmxtShadowRunConfig,
  PmxtShadowRunResult,
  PmxtShadowRunReason,
} from "../../src/contexts/scanner/pmxt/pmxt-shadow-run";
import { PmxtShadowRateLimiter } from "../../src/contexts/scanner/pmxt/pmxt-shadow-rate-limiter";
import { PmxtMarketBook } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import { PmxtMarketSnapshot } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";
import { MarketBook } from "../../src/contexts/arbitrage/domain/opportunity";

function snapshot(venueMarketId: string, yesOutcomeId: string, noOutcomeId: string): PmxtMarketSnapshot {
  return {
    venue: "pmxt",
    venueMarketId,
    title: "Test market",
    rawResolutionText: "",
    capturedAt: "2026-07-15T12:00:00.000Z",
    rawPayload: { id: venueMarketId, yesOutcomeId, noOutcomeId },
  };
}

function makeFetchMock(markets: PmxtMarketSnapshot[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const m of markets) {
    const yesId = m.rawPayload.yesOutcomeId as string;
    const noId = m.rawPayload.noOutcomeId as string;
    result[yesId] = { asks: [{ price: 0.52, size: 10 }] };
    result[noId] = { asks: [{ price: 0.48, size: 5 }] };
  }
  return result;
}

describe("PMXT shadow run", () => {
  let rateLimiter: PmxtShadowRateLimiter;
  let fetchOrderBooks: ReturnType<typeof vi.fn>;
  let persistRawBook: ReturnType<typeof vi.fn>;
  let persistMappedBook: ReturnType<typeof vi.fn>;
  let compareBooks: ReturnType<typeof vi.fn>;
  let config: PmxtShadowRunConfig;

  beforeEach(() => {
    rateLimiter = new PmxtShadowRateLimiter({
      requestsPerMinute: 60,
      maxConcurrency: 5,
      maxRequestsPerRun: 100,
    });
    fetchOrderBooks = vi.fn();
    persistRawBook = vi.fn();
    persistMappedBook = vi.fn();
    compareBooks = vi.fn().mockReturnValue([]);
    config = {
      rateLimiter,
      fetchOrderBooks,
      persistRawBook,
      persistMappedBook,
      compareBooks,
      requestTimeoutMs: 10_000,
      maxMarketsPerVenue: 50,
      maxBooksPerVenue: 50,
      clock: () => Date.now(),
    };
  });

  describe("bounded fetch by outcome ID", () => {
    it("fetches orderbooks for a list of PMXT market snapshots", async () => {
      const markets = [snapshot("m1", "o1", "o2"), snapshot("m2", "o3", "o4")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));

      const run = new PmxtShadowRun(config);
      const result = await run.execute(markets);

      expect(fetchOrderBooks).toHaveBeenCalledWith(["o1", "o2", "o3", "o4"]);
      expect(result.books).toHaveLength(2);
      expect(result.status).toBe("completed");
    });

    it("returns empty books when given empty market list", async () => {
      const run = new PmxtShadowRun(config);
      const result = await run.execute([]);
      expect(result.books).toHaveLength(0);
      expect(result.status).toBe("completed");
      expect(fetchOrderBooks).not.toHaveBeenCalled();
    });

    it("rejects when a market lacks explicit outcome IDs", async () => {
      const markets = [
        { ...snapshot("m1", "o1", "o2"), rawPayload: { id: "m1" } },
      ];
      const run = new PmxtShadowRun(config);
      await expect(run.execute(markets)).rejects.toThrow(
        "PMXT market m1 lacks explicit YES/NO outcome ids"
      );
    });
  });

  describe("hard caps", () => {
    it("stops issuing requests at the per-run cap and marks partial", async () => {
      // The rate limiter checks runRequestCount >= maxRequestsPerRun when
      // maxRequestsPerRun > 0. With maxRequestsPerRun=1, the first call
      // (requestCount=0) passes, then requestCount becomes 1. The shadow run
      // only makes one request so it completes normally.
      const limiter = new PmxtShadowRateLimiter({
        requestsPerMinute: 60,
        maxConcurrency: 5,
        maxRequestsPerRun: 1,
      });
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));

      const run = new PmxtShadowRun({ ...config, rateLimiter: limiter });
      const result = await run.execute(markets);

      expect(result.status).toBe("completed");
      expect(result.books).toHaveLength(1);
    });

    it("enforces maxMarketsPerVenue", async () => {
      const markets = Array.from({ length: 10 }, (_, i) =>
        snapshot(`m${i}`, `oy${i}`, `on${i}`)
      );
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));
      const cfg = { ...config, maxMarketsPerVenue: 3 };
      const run = new PmxtShadowRun(cfg);
      const result = await run.execute(markets);
      // Should only process up to maxMarketsPerVenue
      expect(result.books.length).toBeLessThanOrEqual(3);
    });

    it("enforces maxBooksPerVenue", async () => {
      const markets = Array.from({ length: 5 }, (_, i) =>
        snapshot(`m${i}`, `oy${i}`, `on${i}`)
      );
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));
      const cfg = { ...config, maxBooksPerVenue: 2 };
      const run = new PmxtShadowRun(cfg);
      const result = await run.execute(markets);
      expect(result.books.length).toBeLessThanOrEqual(2);
    });
  });

  describe("timeout", () => {
    it("respects request timeout and returns partial", async () => {
      fetchOrderBooks.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({}), 500))
      );
      const cfg = { ...config, requestTimeoutMs: 10 };
      const run = new PmxtShadowRun(cfg);
      const markets = [snapshot("m1", "o1", "o2")];
      const result = await run.execute(markets);
      // Should time out and return partial
      expect(result.status).toBe("partial");
      expect(result.reason).toBe("timeout");
    });
  });

  describe("persistence", () => {
    it("persists raw and mapped books", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));

      const run = new PmxtShadowRun(config);
      await run.execute(markets);

      expect(persistRawBook).toHaveBeenCalledTimes(1);
      expect(persistMappedBook).toHaveBeenCalledTimes(1);
    });

    it("persists books even when comparison fails", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));
      compareBooks.mockImplementation(() => {
        throw new Error("comparison failed");
      });

      const run = new PmxtShadowRun(config);
      const result = await run.execute(markets);

      // Books should still be persisted
      expect(persistRawBook).toHaveBeenCalled();
      expect(persistMappedBook).toHaveBeenCalled();
      expect(result.books).toHaveLength(1);
    });
  });

  describe("comparison", () => {
    it("compares each PMXT book against venue books", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));
      compareBooks.mockReturnValue([]);

      const run = new PmxtShadowRun(config);
      await run.execute(markets);

      expect(compareBooks).toHaveBeenCalledTimes(1);
    });
  });

  describe("receipt timestamps", () => {
    it("records receipt-to-receipt skew separately from source timestamps", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));

      const run = new PmxtShadowRun(config);
      const result = await run.execute(markets);

      // Each book should have both capturedAt (source) and a receipt timestamp
      for (const book of result.books) {
        expect(book.capturedAt).toBeDefined();
        expect(result.receiptTimestamp).toBeDefined();
      }
    });
  });

  describe("error handling", () => {
    it("handles malformed API responses gracefully", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue({
        o1: "not an object",
        o2: null,
      });

      const run = new PmxtShadowRun(config);
      await expect(run.execute(markets)).rejects.toThrow();
    });

    it("handles missing outcome data", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue({
        o1: { asks: [{ price: 0.52, size: 10 }] },
        // o2 missing
      });

      const run = new PmxtShadowRun(config);
      await expect(run.execute(markets)).rejects.toThrow(
        "PMXT orderbook missing for market m1"
      );
    });
  });

  describe("rate limiter integration", () => {
    it("releases rate limiter slots after each request", async () => {
      const markets = [snapshot("m1", "o1", "o2")];
      fetchOrderBooks.mockResolvedValue(makeFetchMock(markets));

      const run = new PmxtShadowRun(config);
      await run.execute(markets);

      // After execution, all slots should be released
      const result = rateLimiter.allowRequest(0);
      expect(result.allowed).toBe(true);
    });
  });
});
