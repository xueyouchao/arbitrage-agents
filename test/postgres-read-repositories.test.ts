import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PostgresReadRepositories } from "../src/contexts/api/postgres-read-repositories";

const poolQuery = vi.fn();
const poolEnd = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ query: poolQuery, end: poolEnd }))
}));

// The shared DATABASE_POOL is injected; the repository no longer
// constructs its own Pool. Tests build the injected pool the same way
// the real DatabaseModule would (new Pool({...})), then hand it in.
function injectedPool(): Pool {
  return new Pool({ connectionString: "postgres://test" });
}

describe("PostgresReadRepositories", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolEnd.mockReset();
    vi.mocked(Pool).mockClear();
  });

  it("does not own pool lifecycle: injects DATABASE_POOL and implements neither OnModuleDestroy nor a pool.end() call", async () => {
    const pool = injectedPool();
    const repository = new PostgresReadRepositories(pool);

    // The repository must NOT be its own lifecycle owner — the shared
    // DatabasePoolHolder is the single owner of pool.end().
    expect((repository as unknown as { onModuleDestroy?: unknown }).onModuleDestroy).toBeUndefined();

    poolEnd.mockClear();
    // Running a query must not end the pool.
    poolQuery.mockResolvedValue({ rows: [{ total: "0" }] });
    await repository.listMarkets();
    expect(poolEnd).not.toHaveBeenCalled();
  });

  it("lists and gets opportunities with Phase 3 fields, JSONB arrays, numeric coercion, nullable snapshots, and ISO dates", async () => {
    const repository = new PostgresReadRepositories(injectedPool());
    const row = opportunityRow({ notional_edges: [{ targetNotionalUsd: 5, grossEdge: "0.07", estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }] });
    poolQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] }).mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ ...row, notional_edges: JSON.stringify(row.notional_edges), kalshi_orderbook_snapshot_id: null }] });

    const listed = await repository.listOpportunities();
    const found = await repository.getOpportunity("opp-1");

    // The repository must not construct its own Pool — only the
    // injectedPool() helper above called `new Pool` (exactly once).
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({ connectionString: "postgres://test" });
    expect(poolQuery.mock.calls[0][0]).toContain("count(*)");
    expect(poolQuery.mock.calls[1][0]).toContain("kalshi_orderbook_snapshot_id");
    expect(poolQuery.mock.calls[1][0]).toContain("notional_edges");
    expect(poolQuery.mock.calls[1][0]).toContain("data_staleness_ms");
    expect(poolQuery.mock.calls[1][0]).toContain("calculation_version");
    expect(poolQuery.mock.calls[2][1]).toEqual(["opp-1"]);
    expect(listed.data[0]).toMatchObject({
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
    expect(listed.data[0].notionalEdges).toEqual([{ targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }]);
    expect(found?.kalshiOrderbookSnapshotId).toBeUndefined();
    expect(found?.polymarketOrderbookSnapshotId).toBe("polymarket-snapshot-1");
    expect(found?.notionalEdges).toEqual([{ targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.01, estimatedSlippage: 0.004, netEdge: 0.056, fillable: true }]);
  });

  it("maps malformed opportunity notional_edges to an empty array and returns undefined for a missing opportunity", async () => {
    const repository = new PostgresReadRepositories(injectedPool());
    poolQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [opportunityRow({ notional_edges: "not-json" })] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [opportunityRow({ notional_edges: [{ targetNotionalUsd: "5", grossEdge: "0.07", estimatedFees: "0.01", estimatedSlippage: "0.004", netEdge: "0.056", fillable: "true" }] })] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.listOpportunities()).resolves.toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: "opp-1", notionalEdges: [] })]
      })
    );
    await expect(repository.listOpportunities()).resolves.toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: "opp-1", notionalEdges: [] })]
      })
    );
    await expect(repository.getOpportunity("missing")).resolves.toBeUndefined();
  });

  it("maps latest scan run metrics and falls back to safe defaults for missing or invalid rows", async () => {
    const repository = new PostgresReadRepositories(injectedPool());
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
    const repository = new PostgresReadRepositories(injectedPool());
    poolQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] }).mockResolvedValueOnce({ rows: [{
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

    const result = await repository.listMarkets();
    expect(result.data[0]).toMatchObject({
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
    });
  });

  it("maps broader normalized market topics, event types, and non-crypto asset strings", async () => {
    const repository = new PostgresReadRepositories(injectedPool());
    poolQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] }).mockResolvedValueOnce({ rows: [{
      id: "market-2",
      venue: "polymarket",
      venue_market_id: "P2",
      title: "Will Trump win the 2028 GOP nomination?",
      raw_resolution_text: "Resolves YES if Donald J. Trump wins the 2028 Republican presidential nomination.",
      topic: "politics",
      event_type: "nomination",
      asset: "TRUMP",
      threshold: null,
      operator: null,
      deadline: "2028-07-31T00:00:00.000Z",
      timezone: "America/New_York",
      resolution_source: "https://projects.fivethirtyeight.com/2028-election-forecast/",
      payoff_type: "settlement_value",
      ambiguity_flags: [],
      confidence: "0.88"
    }] });

    const result = await repository.listMarkets();
    expect(result.data[0]).toMatchObject({
      id: "market-2",
      venue: "polymarket",
      venueMarketId: "P2",
      topic: "politics",
      eventType: "nomination",
      asset: "TRUMP",
      threshold: undefined,
      operator: undefined,
      deadline: "2028-07-31T00:00:00.000Z",
      timezone: "America/New_York",
      resolutionSource: "https://projects.fivethirtyeight.com/2028-election-forecast/",
      payoffType: "settlement_value",
      ambiguityFlags: [],
      confidence: 0.88
    });
  });

  it("lists paper-trade simulations for an opportunity and coerces numeric fields", async () => {
    const repository = new PostgresReadRepositories(injectedPool());
    poolQuery.mockResolvedValueOnce({ rows: [{
      id: "sim-1",
      opportunity_id: "opp-1",
      simulated_at: new Date("2026-06-03T12:00:02.000Z"),
      target_notional_usd: "5",
      long_leg: { averagePrice: 0.42, contracts: 11.9048, fees: 0.0042, slippage: 0 },
      hedge_leg: { averagePrice: 0.51, contracts: 9.8039, fees: 0.0051, slippage: 0 },
      adverse_selection_bps: "25",
      partial_fill: false,
      residual_exposure_usd: "0",
      combined_cost: "0.93",
      gross_edge: "0.07",
      net_edge: "0.0607",
      config_version: "seed-config-v1",
      calculation_version: "seed-calc-v1"
    }] });

    const result = await repository.listPaperTradeSimulations("opp-1");

    expect(poolQuery.mock.calls[0][0]).toContain("from paper_trade_simulations");
    expect(poolQuery.mock.calls[0][0]).toContain("where opportunity_id = $1");
    expect(poolQuery.mock.calls[0][1]).toEqual(["opp-1"]);
    expect(result).toEqual([
      expect.objectContaining({
        id: "sim-1",
        opportunityId: "opp-1",
        simulatedAt: "2026-06-03T12:00:02.000Z",
        targetNotionalUsd: 5,
        adverseSelectionBps: 25,
        partialFill: false,
        residualExposureUsd: 0,
        combinedCost: 0.93,
        grossEdge: 0.07,
        netEdge: 0.0607,
        configVersion: "seed-config-v1",
        calculationVersion: "seed-calc-v1",
        longLegFill: {
          averagePrice: 0.42,
          contracts: 11.9048,
          fees: 0.0042,
          slippage: 0
        },
        hedgeLegFill: {
          averagePrice: 0.51,
          contracts: 9.8039,
          fees: 0.0051,
          slippage: 0
        }
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
    theoretical_combined_cost: "0.93",
    theoretical_gross_edge: "0.07",
    theoretical_net_edge: "0.0561",
    executable_size_usd: "12",
    executable_combined_cost: "0.93",
    executable_gross_edge: "0.07",
    executable_net_edge: "0.0561",
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
    first_detected_at: new Date("2026-06-03T12:00:00.000Z"),
    last_verified_at: "2026-06-03T12:00:01.500Z",
    calculation_version: "opportunity-calculator-v2",
    config_version: "phase3-conservative-v1",
    human_review_flag: null,
    human_review_notes: null,
    ...overrides
  };
}
