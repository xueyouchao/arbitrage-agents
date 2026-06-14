import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PostgresReadRepositories } from "../src/contexts/api/postgres-read-repositories";

const poolQuery = vi.fn();
const poolEnd = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ query: poolQuery, end: poolEnd }))
}));

describe("PostgresReadRepositories", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolEnd.mockReset();
    vi.mocked(Pool).mockClear();
  });

  it("lists and gets opportunities with Phase 3 fields, JSONB arrays, numeric coercion, nullable snapshots, and ISO dates", async () => {
    const repository = new PostgresReadRepositories({ databaseUrl: "postgres://test" } as never);
    const row = opportunityRow({ notional_edges: [{ targetNotionalUsd: 5, grossEdge: "0.07", estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }] });
    poolQuery.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ ...row, notional_edges: JSON.stringify(row.notional_edges), kalshi_orderbook_snapshot_id: null }] });

    const listed = await repository.listOpportunities();
    const found = await repository.getOpportunity("opp-1");

    expect(Pool).toHaveBeenCalledWith({ connectionString: "postgres://test" });
    expect(poolQuery.mock.calls[0][0]).toContain("kalshi_orderbook_snapshot_id");
    expect(poolQuery.mock.calls[0][0]).toContain("notional_edges");
    expect(poolQuery.mock.calls[0][0]).toContain("data_staleness_ms");
    expect(poolQuery.mock.calls[0][0]).toContain("calculation_version");
    expect(poolQuery.mock.calls[1][1]).toEqual(["opp-1"]);
    expect(listed[0]).toMatchObject({
      id: "opp-1",
      pairId: "pair-1",
      kalshiOrderbookSnapshotId: "kalshi-snapshot-1",
      polymarketOrderbookSnapshotId: "polymarket-snapshot-1",
      combinedCost: 0.93,
      grossEdge: 0.07,
      estimatedFees: 0.0093,
      estimatedSlippage: 0.0046,
      netEdge: 0.0561,
      maxTradableUsd: 12,
      liquidityRisk: "medium",
      venueRisk: "low",
      equivalenceRisk: "low",
      dataStalenessMs: 500,
      opportunityAgeMs: 1500,
      detectedAt: "2026-06-03T12:00:00.000Z",
      lastVerifiedAt: "2026-06-03T12:00:01.500Z",
      calculationVersion: "opportunity-calculator-v2",
      configVersion: "phase3-conservative-v1"
    });
    expect(listed[0].notionalEdges).toEqual([{ targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }]);
    expect(found?.kalshiOrderbookSnapshotId).toBeUndefined();
    expect(found?.polymarketOrderbookSnapshotId).toBe("polymarket-snapshot-1");
    expect(found?.notionalEdges).toEqual([{ targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }]);
  });

  it("maps malformed opportunity notional_edges to an empty array and returns undefined for a missing opportunity", async () => {
    const repository = new PostgresReadRepositories({ databaseUrl: "postgres://test" } as never);
    poolQuery
      .mockResolvedValueOnce({ rows: [opportunityRow({ notional_edges: "not-json" })] })
      .mockResolvedValueOnce({ rows: [opportunityRow({ notional_edges: [{ targetNotionalUsd: "5", grossEdge: "0.07", estimatedFees: "0.01", estimatedSlippage: "0.004", netEdge: "0.056", fillable: "true" }] })] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.listOpportunities()).resolves.toEqual([
      expect.objectContaining({ id: "opp-1", notionalEdges: [] })
    ]);
    await expect(repository.listOpportunities()).resolves.toEqual([
      expect.objectContaining({ id: "opp-1", notionalEdges: [] })
    ]);
    await expect(repository.getOpportunity("missing")).resolves.toBeUndefined();
  });

  it("maps latest scan run metrics and falls back to safe defaults for missing or invalid rows", async () => {
    const repository = new PostgresReadRepositories({ databaseUrl: "postgres://test" } as never);
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: "scan-1", status: "succeeded", started_at: new Date("2026-06-03T12:00:00.000Z"), completed_at: "2026-06-03T12:00:01.000Z", metrics: { marketsScanned: 2, opportunitiesFound: 1 } }] })
      .mockResolvedValueOnce({ rows: [{ id: "scan-2", status: "weird", started_at: "2026-06-03T12:00:02.000Z", completed_at: null, metrics: { marketsScanned: "2", opportunitiesFound: Number.NaN, failureCategory: "processing", failureReason: "bad parse" } }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.getLatestScanRun()).resolves.toEqual({
      id: "scan-1",
      status: "succeeded",
      startedAt: "2026-06-03T12:00:00.000Z",
      completedAt: "2026-06-03T12:00:01.000Z",
      marketsScanned: 2,
      opportunitiesFound: 1,
      failureCategory: undefined,
      failureReason: undefined
    });
    await expect(repository.getLatestScanRun()).resolves.toEqual({
      id: "scan-2",
      status: "failed",
      startedAt: "2026-06-03T12:00:02.000Z",
      completedAt: undefined,
      marketsScanned: 0,
      opportunitiesFound: 0,
      failureCategory: "processing",
      failureReason: "bad parse"
    });
    await expect(repository.getLatestScanRun()).resolves.toEqual({
      id: "none",
      status: "failed",
      startedAt: "1970-01-01T00:00:00.000Z",
      marketsScanned: 0,
      opportunitiesFound: 0
    });
  });

  it("maps markets and coerces nullable numeric/date fields", async () => {
    const repository = new PostgresReadRepositories({ databaseUrl: "postgres://test" } as never);
    poolQuery.mockResolvedValueOnce({ rows: [{
      id: "market-1",
      venue: "kalshi",
      venue_market_id: "K1",
      title: "BTC above 100k",
      raw_resolution_text: "Coinbase BTC/USD",
      topic: "crypto",
      event_type: "price_above",
      asset: null,
      threshold: "100000.5",
      operator: null,
      deadline: new Date("2026-01-01T00:00:00.000Z"),
      timezone: null,
      resolution_source: null,
      payoff_type: "at_time",
      ambiguity_flags: ["resolution_source_missing"],
      confidence: "0.92"
    }] });

    await expect(repository.listMarkets()).resolves.toEqual([
      expect.objectContaining({
        id: "market-1",
        venue: "kalshi",
        venueMarketId: "K1",
        asset: undefined,
        threshold: 100000.5,
        operator: undefined,
        deadline: "2026-01-01T00:00:00.000Z",
        timezone: undefined,
        resolutionSource: undefined,
        ambiguityFlags: ["resolution_source_missing"],
        confidence: 0.92
      })
    ]);
  });
});

function opportunityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "opp-1",
    candidate_pair_id: "pair-1",
    kalshi_orderbook_snapshot_id: "kalshi-snapshot-1",
    polymarket_orderbook_snapshot_id: "polymarket-snapshot-1",
    long_leg: { venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.42, availableUsd: 20 },
    hedge_leg: { venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.51, availableUsd: 12 },
    combined_cost: "0.93",
    gross_edge: "0.07",
    estimated_fees: "0.0093",
    estimated_slippage: "0.0046",
    net_edge: "0.0561",
    max_tradable_usd: "12",
    notional_edges: [],
    equivalence_class: "A",
    resolution_risk: "low",
    fill_risk: "medium",
    liquidity_risk: "medium",
    venue_risk: "low",
    equivalence_risk: "low",
    data_staleness_ms: 500,
    opportunity_age_ms: 1500,
    detected_at: new Date("2026-06-03T12:00:00.000Z"),
    last_verified_at: "2026-06-03T12:00:01.500Z",
    calculation_version: "opportunity-calculator-v2",
    config_version: "phase3-conservative-v1",
    ...overrides
  };
}
