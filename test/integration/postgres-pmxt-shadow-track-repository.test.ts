import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresPmxtShadowTrackRepository } from "../../src/contexts/scanner/pmxt/postgres-pmxt-shadow-track-repository";
import { createDisposablePostgresDatabase, DisposablePostgresDatabase } from "./postgres-test-database";

let db: DisposablePostgresDatabase;
let pool: Pool;
let repository: PostgresPmxtShadowTrackRepository;

const authoritativeScanRunId = "00000000-0000-4000-8000-000000000010";
const shadowRunId = "00000000-0000-4000-8000-000000000020";
const shadowRunAttemptId = "00000000-0000-4000-8000-000000000030";

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();
  pool = new Pool({ connectionString: db.databaseUrl });
  repository = new PostgresPmxtShadowTrackRepository(pool);
  await db.query(
    `insert into scan_runs (id, status) values ($1, 'succeeded')`,
    [authoritativeScanRunId]
  );
  await db.query(
    `insert into pmxt_shadow_run_attempts
       (id, shadow_run_id, authoritative_scan_run_id, attempt_number, leased_until, worker_id)
     values ($1, $2, $3, 1, now() + interval '1 minute', 'worker-1')`,
    [shadowRunAttemptId, shadowRunId, authoritativeScanRunId]
  );
});

afterEach(async () => {
  await pool?.end();
  await db?.close();
});

describe("PostgresPmxtShadowTrackRepository integration", () => {
  it("persists equivalent-scope coverage, mapping failures, exclusions, and receipts", async () => {
    await repository.saveCoverage({
      authoritativeScanRunId,
      shadowRunId,
      shadowRunAttemptId,
      scope: {
        authoritative: { kind: "series", values: ["KXBTCD"] },
        pmxt: { kind: "series", values: ["KXBTCD"] },
      },
      result: {
        outcome: "compared",
        cause: "scope_equivalent",
        scope: {
          authoritative: { kind: "series", values: ["KXBTCD"] },
          pmxt: { kind: "series", values: ["KXBTCD"] },
        },
        excludedPmxtMarketIds: ["pmxt-out"],
        coverage: {
          kalshi: {
            authoritativeCount: 1,
            pmxtMappedCount: 1,
            overlapCount: 1,
            authoritativeOnlyIds: [],
            pmxtOnlyIds: [],
            duplicateNativeIds: [],
            statusDisagreements: [],
            missingResolutionText: [],
          },
          polymarket: {
            authoritativeCount: 0,
            pmxtMappedCount: 0,
            overlapCount: 0,
            authoritativeOnlyIds: [],
            pmxtOnlyIds: [],
            duplicateNativeIds: [],
            statusDisagreements: [],
            missingResolutionText: [],
          },
          mappingFailures: [
            { pmxtMarketId: "pmxt-bad", reasonCode: "missing_venue_native_id", reason: "missing" },
          ],
          comparisonTimestamp: "2026-07-15T12:00:00.000Z",
          pmxtComparisonTimestamp: "2026-07-15T12:00:05.000Z",
        },
      },
      markets: [
        {
          catalogMarketId: "pmxt-in",
          venue: "kalshi",
          venueNativeId: "KXBTCD-25JUL26",
          eligible: true,
          capturedAt: "2026-07-15T12:00:05.000Z",
          payload: { marketId: "pmxt-in" },
        },
        {
          catalogMarketId: "pmxt-out",
          venue: "kalshi",
          venueNativeId: "NBA-FINALS",
          eligible: false,
          exclusionReason: "out_of_scope",
          capturedAt: "2026-07-15T12:00:06.000Z",
          payload: { marketId: "pmxt-out" },
        },
        {
          catalogMarketId: "pmxt-bad",
          eligible: false,
          exclusionReason: "missing_venue_native_id",
          capturedAt: "2026-07-15T12:00:07.000Z",
          payload: { marketId: "pmxt-bad" },
        },
      ],
    });

    const runs = await db.query<{
      track: string;
      status: string;
      cause: string;
      authoritative_receipt_at: Date;
      pmxt_receipt_at: Date;
    }>(`select track, status, cause, authoritative_receipt_at, pmxt_receipt_at from pmxt_shadow_track_runs`);
    expect(runs.rows).toEqual([
      expect.objectContaining({ track: "reads", status: "completed", cause: "scope_equivalent" }),
    ]);
    expect(runs.rows[0].authoritative_receipt_at.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(runs.rows[0].pmxt_receipt_at.toISOString()).toBe("2026-07-15T12:00:05.000Z");

    const markets = await db.query<{ catalog_market_id: string; eligible: boolean; exclusion_reason: string | null }>(
      `select catalog_market_id, eligible, exclusion_reason from pmxt_shadow_markets order by catalog_market_id`
    );
    expect(markets.rows).toEqual([
      { catalog_market_id: "pmxt-bad", eligible: false, exclusion_reason: "missing_venue_native_id" },
      { catalog_market_id: "pmxt-in", eligible: true, exclusion_reason: null },
      { catalog_market_id: "pmxt-out", eligible: false, exclusion_reason: "out_of_scope" },
    ]);

    const comparisons = await db.query<{ stage: string; outcome: string; cause: string }>(
      `select stage, outcome, cause from pmxt_shadow_comparisons`
    );
    expect(comparisons.rows).toEqual([
      { stage: "coverage", outcome: "mismatch", cause: "scope_equivalent" },
    ]);
  });

  it("persists intact Router clusters and every direct edge", async () => {
    await repository.saveRouterProjection({
      authoritativeScanRunId,
      shadowRunId,
      shadowRunAttemptId,
      anchors: [{ marketId: "pmxt-k" }],
      projection: {
        clusters: [
          {
            clusterId: "cluster-1",
            canonicalTitle: "BTC",
            relations: ["identity", "subset"],
            confidence: 0.9,
            markets: [],
            rawMatches: [],
          },
        ],
        edges: [
          {
            clusterId: "cluster-1",
            marketAId: "pmxt-k",
            marketBId: "pmxt-p",
            relation: "identity",
            confidence: 0.88,
            clusterRelations: ["identity", "subset"],
            clusterConfidence: 0.9,
            kalshiMemberId: "pmxt-k",
            polymarketMemberId: "pmxt-p",
            kalshiNativeId: "KXBTC",
            polymarketNativeId: "0xabc",
            eligibleByDefault: true,
            rawEdge: {
              marketAId: "pmxt-k",
              marketBId: "pmxt-p",
              relation: "identity",
              confidence: 0.88,
            },
          },
          {
            clusterId: "cluster-1",
            marketAId: "pmxt-k",
            marketBId: "pmxt-p",
            relation: "subset",
            confidence: 0.7,
            clusterRelations: ["identity", "subset"],
            clusterConfidence: 0.9,
            kalshiMemberId: "pmxt-k",
            polymarketMemberId: "pmxt-p",
            kalshiNativeId: "KXBTC",
            polymarketNativeId: "0xabc",
            eligibleByDefault: false,
            exclusionReason: "non_identity_relation",
            rawEdge: {
              marketAId: "pmxt-k",
              marketBId: "pmxt-p",
              relation: "subset",
              confidence: 0.7,
            },
          },
        ],
        candidates: [],
      },
    });

    const clusters = await db.query<{ cluster_id: string; payload: { relations: string[] } }>(
      `select cluster_id, payload from pmxt_shadow_router_clusters`
    );
    expect(clusters.rows).toEqual([
      { cluster_id: "cluster-1", payload: expect.objectContaining({ relations: ["identity", "subset"] }) },
    ]);
    const edges = await db.query<{ relation: string; eligible: boolean; exclusion_reason: string | null }>(
      `select relation, eligible, exclusion_reason from pmxt_shadow_router_edges order by relation`
    );
    expect(edges.rows).toEqual([
      { relation: "identity", eligible: true, exclusion_reason: null },
      { relation: "subset", eligible: false, exclusion_reason: "non_identity_relation" },
    ]);
  });
});
