import { describe, expect, it, vi } from "vitest";
import { runPmxtAnchoredRouterTrack } from "../../src/contexts/scanner/pmxt/pmxt-anchored-router-track";
import { PmxtMarketSnapshot } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";

const identity = {
  authoritativeScanRunId: "scan-1",
  shadowRunId: "shadow-1",
  shadowRunAttemptId: "attempt-1",
};

function market(overrides: Partial<PmxtMarketSnapshot> = {}): PmxtMarketSnapshot {
  return {
    venue: "pmxt",
    venueMarketId: "KXBTC",
    catalogMarketId: "pmxt-k",
    sourceExchange: "kalshi",
    title: "BTC",
    rawResolutionText: "rules",
    capturedAt: "2026-07-15T12:00:00.000Z",
    rawPayload: { marketId: "pmxt-k", slug: "KXBTC" },
    ...overrides,
  };
}

const cluster = {
  clusterId: "cluster-1",
  canonicalTitle: "BTC",
  relations: ["identity" as const],
  confidence: 0.9,
  markets: [
    { marketId: "pmxt-k", sourceExchange: "kalshi", title: "BTC" },
    { marketId: "pmxt-p", sourceExchange: "polymarket", title: "BTC" },
  ],
  rawMatches: [
    { marketAId: "pmxt-k", marketBId: "pmxt-p", relation: "identity" as const, confidence: 0.88 },
  ],
};

describe("anchored PMXT Router track", () => {
  it("uses series-scoped markets as anchors and proven native identities for projection", async () => {
    const fetchAnchoredMarketClusters = vi.fn().mockResolvedValue([cluster]);
    const saveRouterProjection = vi.fn().mockResolvedValue(undefined);

    const result = await runPmxtAnchoredRouterTrack({
      ...identity,
      seriesScopedMarkets: [
        market(),
        market({
          venueMarketId: "0xabc",
          catalogMarketId: "pmxt-p",
          sourceExchange: "polymarket",
          rawPayload: { marketId: "pmxt-p", slug: "btc-above-100k" },
        }),
      ],
      routerClient: { fetchAnchoredMarketClusters },
      repository: { saveRouterProjection },
    });

    expect(fetchAnchoredMarketClusters).toHaveBeenCalledWith([
      { marketId: "pmxt-k" },
      { marketId: "pmxt-p" },
    ]);
    expect(result.candidates).toEqual([
      expect.objectContaining({ kalshiNativeId: "KXBTC", polymarketNativeId: "0xabc" }),
    ]);
    expect(saveRouterProjection).toHaveBeenCalledWith(
      expect.objectContaining({ projection: result })
    );
  });

  it("fails closed when a series-scoped market lacks a catalog anchor", async () => {
    await expect(runPmxtAnchoredRouterTrack({
      ...identity,
      seriesScopedMarkets: [market({ catalogMarketId: undefined })],
      routerClient: { fetchAnchoredMarketClusters: vi.fn() },
      repository: { saveRouterProjection: vi.fn() },
    })).rejects.toThrow("catalog anchor");
  });
});
