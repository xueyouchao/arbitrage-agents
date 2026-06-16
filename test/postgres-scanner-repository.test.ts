import { describe, expect, it, vi } from "vitest";
import { Pool, PoolClient } from "pg";
import { PostgresScannerRepository } from "../src/contexts/scanner/postgres-scanner-repository";
import { CompletedScanArtifacts } from "../src/contexts/scanner/scanner-repository";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import { LlmEvaluationRecord } from "../src/contexts/llm/application/llm-evaluation";
import { uuidFromStableKey } from "../src/contexts/shared/stable-id";

const startedAt = "2026-06-03T11:59:59.000Z";
const capturedAt = "2026-06-03T12:00:00.000Z";
const completedAt = "2026-06-03T12:00:01.000Z";

const kalshiMarket: NormalizedMarket = {
  id: "kalshi:K1",
  venue: "kalshi",
  venueMarketId: "K1",
  title: "BTC above 100k",
  rawResolutionText: "Coinbase BTC/USD",
  topic: "crypto",
  eventType: "price_above",
  asset: "BTC",
  threshold: 100000,
  operator: ">",
  deadline: "2026-01-01T00:00:00.000Z",
  resolutionSource: "Coinbase",
  payoffType: "at_time",
  ambiguityFlags: [],
  confidence: 0.95
};
const polymarketMarket: NormalizedMarket = { ...kalshiMarket, id: "polymarket:P1", venue: "polymarket", venueMarketId: "P1" };
const pair: CandidatePair = { id: "kalshi:K1:polymarket:P1", kalshiMarket, polymarketMarket, reasons: ["deterministic_fields_match"] };
const secondPair: CandidatePair = { ...pair, id: "kalshi:K1:polymarket:P1:second" };
const decision: EquivalenceDecision = { pairId: pair.id, equivalenceClass: "A", decision: "tradable", reasons: [] };
const secondDecision: EquivalenceDecision = { pairId: secondPair.id, equivalenceClass: "B", decision: "alert_only", reasons: ["llm_failed"] };

function llm(id: string, status: "succeeded" | "failed", isPersisted?: boolean): LlmEvaluationRecord {
  return {
    id,
    taskType: "market_equivalence",
    promptVersion: "test-v1",
    model: "test-model",
    input: {},
    inputHash: `${id}-hash`,
    output: {},
    parsedOutput: {},
    status,
    promptTokens: 1,
    completionTokens: 1,
    estimatedCostUsd: 0,
    latencyMs: 1,
    createdAt: capturedAt,
    ...(isPersisted === undefined ? {} : { isPersisted })
  };
}

describe("PostgresScannerRepository", () => {
  it("persists Phase 3 scan artifacts and preserves only persisted successful LLM IDs", async () => {
    const { pool, client } = fakePool();
    const repository = new PostgresScannerRepository(pool);
    const completed = await repository.saveCompletedScan(artifacts());

    expect(completed).toMatchObject({ status: "succeeded", completedAt });
    expect(client.query).toHaveBeenCalledWith("begin");
    expect(client.query).toHaveBeenCalledWith("commit");
    expect(client.release).toHaveBeenCalledOnce();

    const orderbookQueries = callsContaining(client, "insert into orderbook_snapshots");
    expect(orderbookQueries).toHaveLength(2);
    expect(orderbookQueries[0].sql).toContain("yes_available_usd");
    expect(orderbookQueries[0].params).toEqual([
      uuidFromStableKey("scan-1:kalshi:K1:2026-06-03T12:00:00.000Z"),
      "scan-1",
      uuidFromStableKey(kalshiMarket.id),
      0.42,
      0.62,
      20,
      30,
      JSON.stringify({ source: "kalshi" }),
      capturedAt,
      false
    ]);

    const normalizedQueries = callsContaining(client, "insert into normalized_markets");
    expect(normalizedQueries[0].params[16]).toBeNull();
    expect(normalizedQueries[1].params[16]).toBe("llm-persisted-market");
    expect(normalizedQueries[0].sql).toContain("when excluded.llm_evaluation_id is null then normalized_markets.llm_evaluation_id");

    const pairQueries = callsContaining(client, "insert into candidate_pairs");
    expect(pairQueries[0].params[6]).toBe("llm-persisted-pair");
    expect(pairQueries[1].params[6]).toBeNull();
    expect(pairQueries[0].sql).toContain("when excluded.llm_evaluation_id is null then candidate_pairs.llm_evaluation_id");

    const opportunityQueries = callsContaining(client, "insert into opportunities");
    expect(opportunityQueries).toHaveLength(1);
    expect(opportunityQueries[0].sql).toContain("kalshi_orderbook_snapshot_id");
    expect(opportunityQueries[0].sql).toContain("polymarket_orderbook_snapshot_id");
    expect(opportunityQueries[0].sql).toContain("notional_edges");
    expect(opportunityQueries[0].sql).toContain("liquidity_risk");
    expect(opportunityQueries[0].sql).toContain("venue_risk");
    expect(opportunityQueries[0].sql).toContain("equivalence_risk");
    expect(opportunityQueries[0].sql).toContain("data_staleness_ms");
    expect(opportunityQueries[0].sql).toContain("opportunity_age_ms");
    expect(opportunityQueries[0].sql).toContain("calculation_version");
    expect(opportunityQueries[0].sql).toContain("config_version");
    expect(opportunityQueries[0].sql).toContain("opportunity_age_ms = greatest(0, floor(extract(epoch from (excluded.last_verified_at - opportunities.detected_at)) * 1000)::integer)");
    expect(opportunityQueries[0].params).toEqual([
      uuidFromStableKey("opp-1"),
      uuidFromStableKey(pair.id),
      uuidFromStableKey("scan-1:kalshi:K1:2026-06-03T12:00:00.000Z"),
      uuidFromStableKey("scan-1:polymarket:P1:2026-06-03T12:00:00.000Z"),
      JSON.stringify(opportunity.longLeg),
      JSON.stringify(opportunity.hedgeLeg),
      0.93,
      0.07,
      0.0093,
      0.0046,
      0.0561,
      12,
      JSON.stringify(opportunity.notionalEdges),
      "A",
      "low",
      "medium",
      "medium",
      "low",
      "low",
      500,
      0,
      capturedAt,
      capturedAt,
      "opportunity-calculator-v2",
      "phase3-conservative-v1"
    ]);
  });

  it("rolls back and releases the client when an artifact references a missing persisted ID", async () => {
    const { pool, client } = fakePool();
    const repository = new PostgresScannerRepository(pool);
    const broken = artifacts({ missingOrderbookMarket: true });

    await expect(repository.saveCompletedScan(broken)).rejects.toThrow("Missing persisted id for missing:book");

    expect(client.query).toHaveBeenCalledWith("begin");
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.query).not.toHaveBeenCalledWith("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

const opportunity: CrossVenueOpportunity = {
  id: "opp-1",
  pairId: pair.id,
  longLeg: { venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.42, availableUsd: 20, feeRate: 0.01, slippageRate: 0.005 },
  hedgeLeg: { venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.51, availableUsd: 12, feeRate: 0.01, slippageRate: 0.005 },
  combinedCost: 0.93,
  grossEdge: 0.07,
  estimatedFees: 0.0093,
  estimatedSlippage: 0.0046,
  netEdge: 0.0561,
  maxTradableUsd: 12,
  theoreticalCombinedCost: 0.93,
  theoreticalGrossEdge: 0.07,
  theoreticalNetEdge: 0.0561,
  executableSizeUsd: 12,
  executableCombinedCost: 0.93,
  executableGrossEdge: 0.07,
  executableNetEdge: 0.0561,
  notionalEdges: [
    { targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.0093, estimatedSlippage: 0.0046, netEdge: 0.0561, fillable: true },
    { targetNotionalUsd: 25, grossEdge: 0.07, estimatedFees: 0.0093, estimatedSlippage: 0.0046, netEdge: 0.0561, fillable: false }
  ],
  equivalenceClass: "A",
  resolutionRisk: "low",
  fillRisk: "medium",
  liquidityRisk: "medium",
  venueRisk: "low",
  equivalenceRisk: "low",
  dataStalenessMs: 500,
  opportunityAgeMs: 0,
  detectedAt: capturedAt,
  firstDetectedAt: capturedAt,
  lastVerifiedAt: capturedAt,
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1"
};

function artifacts(options: { missingOrderbookMarket?: boolean } = {}): CompletedScanArtifacts {
  const kalshiSnapshotId = "scan-1:kalshi:K1:2026-06-03T12:00:00.000Z";
  const polymarketSnapshotId = "scan-1:polymarket:P1:2026-06-03T12:00:00.000Z";
  return {
    scanRun: {
      id: "scan-1",
      status: "succeeded",
      startedAt,
      metrics: { marketsScanned: 2, normalizedMarkets: 2, candidatePairs: 2, opportunitiesFound: 1, llmEvaluations: 3 }
    },
    completeScanRun: (scanRun) => ({ ...scanRun, completedAt }),
    snapshots: [
      { venue: "kalshi", venueMarketId: "K1", title: kalshiMarket.title, rawResolutionText: kalshiMarket.rawResolutionText, rawPayload: { source: "kalshi" }, capturedAt },
      { venue: "polymarket", venueMarketId: "P1", title: polymarketMarket.title, rawResolutionText: polymarketMarket.rawResolutionText, rawPayload: { source: "polymarket" }, capturedAt }
    ],
    normalizedMarkets: [
      { market: kalshiMarket, llmEvaluation: llm("llm-unpersisted-market", "succeeded", false) },
      { market: polymarketMarket, llmEvaluation: llm("llm-persisted-market", "succeeded") }
    ],
    candidatePairs: [
      { pair, decision, llmEvaluation: llm("llm-persisted-pair", "succeeded", true) },
      { pair: secondPair, decision: secondDecision, llmEvaluation: llm("llm-failed-pair", "failed", true) }
    ],
    orderbookSnapshots: [
      {
        id: kalshiSnapshotId,
        scanRunId: "scan-1",
        normalizedMarketId: options.missingOrderbookMarket ? "missing:book" : kalshiMarket.id,
        venue: "kalshi",
        venueMarketId: "K1",
        yesAsk: 0.42,
        noAsk: 0.62,
        yesAvailableUsd: 20,
        noAvailableUsd: 30,
        rawPayload: { source: "kalshi" },
        capturedAt,
        stale: false
      },
      {
        id: polymarketSnapshotId,
        scanRunId: "scan-1",
        normalizedMarketId: polymarketMarket.id,
        venue: "polymarket",
        venueMarketId: "P1",
        yesAsk: 0.5,
        noAsk: 0.51,
        yesAvailableUsd: 50,
        noAvailableUsd: 12,
        rawPayload: { source: "polymarket" },
        capturedAt,
        stale: false
      }
    ],
    opportunities: [{ opportunity, kalshiOrderbookSnapshotId: kalshiSnapshotId, polymarketOrderbookSnapshotId: polymarketSnapshotId }]
  };
}

function fakePool(): { pool: Pool; client: PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } } {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into normalized_markets") || sql.includes("insert into candidate_pairs")) {
        return { rows: [{ id: params?.[0] }] };
      }
      return { rows: [] };
    }),
    release: vi.fn()
  } as unknown as PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

  return {
    pool: { connect: vi.fn(async () => client), end: vi.fn() } as unknown as Pool,
    client
  };
}

function callsContaining(client: { query: ReturnType<typeof vi.fn> }, text: string): Array<{ sql: string; params: unknown[] }> {
  return client.query.mock.calls
    .filter(([sql]) => typeof sql === "string" && sql.includes(text))
    .map(([sql, params]) => ({ sql: sql as string, params: params as unknown[] }));
}
