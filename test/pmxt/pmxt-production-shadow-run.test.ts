import { describe, expect, it, vi } from "vitest";
import { VenueMarketSnapshot } from "../../src/contexts/venues/domain/venue-market";
import {
  PmxtProductionShadowRun,
  PmxtProductionShadowRunDeps,
} from "../../src/contexts/scanner/pmxt/pmxt-production-shadow-run";

const identity = {
  authoritativeScanRunId: "scan-1",
  shadowRunId: "shadow-1",
  shadowRunAttemptId: "attempt-1",
};

const authoritative: VenueMarketSnapshot[] = [
  {
    venue: "kalshi",
    venueMarketId: "KXBTCD-26JUL-T100000",
    title: "BTC above 100k",
    rawResolutionText: "Resolves yes above 100k",
    capturedAt: "2026-07-22T12:00:00.000Z",
    rawPayload: {},
  },
  {
    venue: "polymarket",
    venueMarketId: "0xcondition",
    title: "BTC above 100k",
    rawResolutionText: "Resolves yes above 100k",
    capturedAt: "2026-07-22T12:00:00.000Z",
    rawPayload: { slug: "btc-multi-strikes-weekly" },
  },
];

const kalshiCatalog = [{
  marketId: "catalog-k",
  slug: "KXBTCD-26JUL-T100000",
  title: "BTC above 100k",
  description: "Resolves yes above 100k",
  outcomes: [{ outcomeId: "k-yes", label: "Yes" }, { outcomeId: "k-no", label: "No" }],
}];
const polymarketCatalog = [{
  marketId: "catalog-p",
  contractAddress: "0xcondition",
  title: "BTC above 100k",
  description: "Resolves yes above 100k",
  outcomes: [{ outcomeId: "p-yes", label: "Yes" }, { outcomeId: "p-no", label: "No" }],
}];

function buildDeps(overrides: Partial<PmxtProductionShadowRunDeps> = {}): PmxtProductionShadowRunDeps {
  return {
    authoritativeRepository: { listByScanRunId: vi.fn().mockResolvedValue(authoritative) },
    kalshiCatalogClient: { fetchEvents: vi.fn().mockResolvedValue([{ markets: kalshiCatalog }]) },
    polymarketCatalogClient: { fetchEvents: vi.fn().mockResolvedValue([{ markets: polymarketCatalog }]) },
    routerClient: { fetchAnchoredMarketClusters: vi.fn().mockResolvedValue([]) },
    repository: {
      saveCoverage: vi.fn().mockResolvedValue(undefined),
      saveRouterProjection: vi.fn().mockResolvedValue(undefined),
    },
    kalshiSeries: "KXBTCD",
    polymarketSeries: "btc-multi-strikes-weekly",
    readsEnabled: true,
    routerEnabled: true,
    clock: () => "2026-07-22T12:01:00.000Z",
    ...overrides,
  };
}

describe("PmxtProductionShadowRun", () => {
  it("reads the claimed authoritative scan and persists equivalent-scope coverage plus anchored Router projection", async () => {
    const deps = buildDeps();

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.authoritativeRepository.listByScanRunId).toHaveBeenCalledWith("scan-1");
    expect(deps.kalshiCatalogClient.fetchEvents).toHaveBeenCalledWith({ series: "KXBTCD" });
    expect(deps.polymarketCatalogClient.fetchEvents).toHaveBeenCalledWith({ series: "btc-multi-strikes-weekly" });
    expect(deps.repository.saveCoverage).toHaveBeenCalledWith(expect.objectContaining({
      ...identity,
      result: expect.objectContaining({ outcome: "compared", cause: "scope_equivalent" }),
    }));
    expect(deps.routerClient!.fetchAnchoredMarketClusters).toHaveBeenCalledWith([
      { marketId: "catalog-k" },
      { marketId: "catalog-p" },
    ]);
    expect(deps.repository.saveRouterProjection).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "completed" });
  });

  it("fetches exact catalogs for router-only anchors without saving reads coverage", async () => {
    const deps = buildDeps({ readsEnabled: false, routerEnabled: true });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.kalshiCatalogClient.fetchEvents).toHaveBeenCalledWith({ series: "KXBTCD" });
    expect(deps.polymarketCatalogClient.fetchEvents).toHaveBeenCalledWith({ series: "btc-multi-strikes-weekly" });
    expect(deps.repository.saveCoverage).not.toHaveBeenCalled();
    expect(deps.repository.saveRouterProjection).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
  });

  it("isolates reads and Router failures so one successful track yields partial", async () => {
    const deps = buildDeps({
      repository: {
        saveCoverage: vi.fn().mockRejectedValue(new Error("coverage database unavailable")),
        saveRouterProjection: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.repository.saveRouterProjection).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "partial",
      reason: "reads: coverage database unavailable",
      tracks: {
        reads: { status: "failed", reason: "coverage database unavailable" },
        router: { status: "completed" },
      },
    });
  });

  it("persists an excluded reads result and returns partial when an exact catalog is empty", async () => {
    const deps = buildDeps({
      kalshiCatalogClient: { fetchEvents: vi.fn().mockResolvedValue([]) },
      routerEnabled: false,
    });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.repository.saveCoverage).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ outcome: "excluded", cause: "scope_unproven" }),
    }));
    expect(result).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("scope_unproven"),
    });
  });

  it("excludes scope-unproven catalog records instead of claiming completed parity", async () => {
    const deps = buildDeps({
      kalshiCatalogClient: {
        fetchEvents: vi.fn().mockResolvedValue([{ markets: [{ ...kalshiCatalog[0], slug: undefined }] }]),
      },
      routerEnabled: false,
    });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.repository.saveCoverage).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ outcome: "excluded", cause: "scope_unproven" }),
      markets: expect.arrayContaining([
        expect.objectContaining({ eligible: false, exclusionReason: expect.stringContaining("not proven") }),
      ]),
    }));
    expect(result.status).toBe("partial");
  });

  it("returns partial instead of successful Router coverage when an exact anchor catalog is empty", async () => {
    const deps = buildDeps({
      kalshiCatalogClient: { fetchEvents: vi.fn().mockResolvedValue([]) },
      readsEnabled: false,
      routerEnabled: true,
    });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(deps.repository.saveCoverage).not.toHaveBeenCalled();
    expect(deps.repository.saveRouterProjection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "partial",
      reason: "router: scope_unproven",
    });
  });

  it("returns failed only when every requested track fails", async () => {
    const deps = buildDeps({
      repository: {
        saveCoverage: vi.fn().mockRejectedValue(new Error("reads failed")),
        saveRouterProjection: vi.fn().mockRejectedValue(new Error("router failed")),
      },
    });

    const result = await new PmxtProductionShadowRun(deps).runClaimedShadow(identity);

    expect(result).toMatchObject({ status: "failed" });
  });
});
