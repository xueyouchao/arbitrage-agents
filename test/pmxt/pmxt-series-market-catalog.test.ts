import { describe, expect, it, vi } from "vitest";
import { fetchSeriesMarketCatalog } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-series-market-catalog";

function market(marketId: string) {
  return {
    marketId,
    title: marketId,
    outcomes: [],
    volume24h: 0,
    liquidity: 0,
    url: "",
  };
}

describe("PMXT series market catalog", () => {
  it("rejects an empty series instead of widening scope", async () => {
    const fetchEvents = vi.fn();

    await expect(fetchSeriesMarketCatalog({ fetchEvents }, "  ")).rejects.toThrow(
      "PMXT series is required"
    );
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("fetches events with the exact series scope and flattens their markets", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([
      { id: "event-1", markets: [market("market-1"), market("market-2")] },
      { id: "event-2", markets: [market("market-3")] },
    ]);

    const result = await fetchSeriesMarketCatalog({ fetchEvents }, "KXBTCD");

    expect(fetchEvents).toHaveBeenCalledWith({ series: "KXBTCD" });
    expect(result.map((item) => item.marketId)).toEqual(["market-1", "market-2", "market-3"]);
  });

  it("deduplicates by stable catalog marketId while preserving first-seen order", async () => {
    const first = market("market-1");
    const duplicate = { ...market("market-1"), title: "duplicate" };
    const fetchEvents = vi.fn().mockResolvedValue([
      { id: "event-1", markets: [first, market("market-2")] },
      { id: "event-2", markets: [duplicate] },
    ]);

    const result = await fetchSeriesMarketCatalog({ fetchEvents }, "KXBTCD");

    expect(result).toEqual([first, market("market-2")]);
  });

  it("returns an empty catalog when the exact series has no events", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([]);

    await expect(fetchSeriesMarketCatalog({ fetchEvents }, "KXBTCD")).resolves.toEqual([]);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed event markets instead of falling back to a global fetch", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([{ id: "event-1", markets: null }]);

    await expect(fetchSeriesMarketCatalog({ fetchEvents }, "KXBTCD")).rejects.toThrow(
      "PMXT event event-1 has malformed markets"
    );
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it("rejects markets without a stable catalog marketId", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([
      { id: "event-1", markets: [{ title: "missing identity", outcomes: [] }] },
    ]);

    await expect(fetchSeriesMarketCatalog({ fetchEvents }, "KXBTCD")).rejects.toThrow(
      "PMXT series market is missing marketId"
    );
  });
});
