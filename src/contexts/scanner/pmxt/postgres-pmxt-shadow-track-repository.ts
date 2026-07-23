import { Pool, PoolClient } from "pg";
import {
  PmxtShadowTrackRepository,
  SavePmxtCoverage,
  SavePmxtRouterProjection,
} from "./pmxt-shadow-track-repository";
import { PmxtCoverageComparisonResult } from "./pmxt-coverage-comparator";

/**
 * Compute the comparison outcome from coverage data instead of always
 * writing "match". A compared result is "match" only when there are no
 * discrepancies; otherwise it is "mismatch".
 */
function coverageOutcome(coverage?: PmxtCoverageComparisonResult): string {
  if (!coverage) return "match";
  const hasDiscrepancies =
    coverage.kalshi.authoritativeOnlyIds.length > 0 ||
    coverage.kalshi.pmxtOnlyIds.length > 0 ||
    coverage.kalshi.duplicateNativeIds.length > 0 ||
    coverage.kalshi.statusDisagreements.length > 0 ||
    coverage.kalshi.missingResolutionText.length > 0 ||
    coverage.polymarket.authoritativeOnlyIds.length > 0 ||
    coverage.polymarket.pmxtOnlyIds.length > 0 ||
    coverage.polymarket.duplicateNativeIds.length > 0 ||
    coverage.polymarket.statusDisagreements.length > 0 ||
    coverage.polymarket.missingResolutionText.length > 0 ||
    coverage.mappingFailures.length > 0;
  return hasDiscrepancies ? "mismatch" : "match";
}

export class PostgresPmxtShadowTrackRepository implements PmxtShadowTrackRepository {
  constructor(
    private readonly pool: Pool,
    private readonly rawRetentionDays: number = 0
  ) {}

  async saveCoverage(input: SavePmxtCoverage): Promise<void> {
    await this.transaction(async (client) => {
      const coverage = input.result.coverage;
      const trackRunId = await this.upsertTrackRun(client, {
        ...input,
        track: "reads",
        status: input.result.outcome === "compared" ? "completed" : "excluded",
        cause: input.result.cause,
        scope: input.scope,
        authoritativeReceiptAt: coverage?.comparisonTimestamp,
        pmxtReceiptAt: coverage?.pmxtComparisonTimestamp,
        metadata: { excludedPmxtMarketIds: input.result.excludedPmxtMarketIds },
      });

      for (const market of input.markets) {
        // When raw retention is 0, never persist the full raw payload.
        const payload = this.rawRetentionDays > 0 ? market.payload : { catalogMarketId: market.catalogMarketId };
        await client.query(
          `insert into pmxt_shadow_markets
             (shadow_track_run_id, catalog_market_id, venue, venue_native_id,
              eligible, exclusion_reason, captured_at, payload)
           values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
           on conflict (shadow_track_run_id, catalog_market_id) do nothing`,
          [
            trackRunId,
            market.catalogMarketId,
            market.venue ?? null,
            market.venueNativeId ?? null,
            market.eligible,
            market.exclusionReason ?? null,
            market.capturedAt,
            JSON.stringify(payload),
          ]
        );
      }

      await client.query(
        `insert into pmxt_shadow_comparisons
           (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id,
            stage, outcome, cause, authoritative, shadow, provenance)
         values ($1, $2, $3, 'coverage', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
         on conflict (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id, stage) do nothing`,
        [
          input.authoritativeScanRunId,
          input.shadowRunId,
          input.shadowRunAttemptId,
          input.result.outcome === "compared" ? coverageOutcome(coverage) : "excluded",
          input.result.cause,
          JSON.stringify({ scope: input.scope.authoritative, coverage: coverage && {
            kalshi: coverage.kalshi,
            polymarket: coverage.polymarket,
          } }),
          JSON.stringify({
            scope: input.scope.pmxt,
            mappingFailures: coverage?.mappingFailures ?? [],
            excludedPmxtMarketIds: input.result.excludedPmxtMarketIds,
          }),
          JSON.stringify({
            authoritativeReceiptAt: coverage?.comparisonTimestamp ?? null,
            pmxtReceiptAt: coverage?.pmxtComparisonTimestamp ?? null,
          }),
        ]
      );
    });
  }

  async saveRouterProjection(input: SavePmxtRouterProjection): Promise<void> {
    await this.transaction(async (client) => {
      const trackRunId = await this.upsertTrackRun(client, {
        ...input,
        track: "router",
        status: "completed",
        cause: "anchored_direct_edges_persisted",
        scope: {},
        metadata: { anchors: input.anchors },
      });

      for (const cluster of input.projection.clusters) {
        await client.query(
          `insert into pmxt_shadow_router_clusters
             (shadow_track_run_id, cluster_id, payload)
           values ($1, $2, $3::jsonb)
           on conflict (shadow_track_run_id, cluster_id) do nothing`,
          [trackRunId, cluster.clusterId, JSON.stringify(cluster)]
        );
      }

      for (let edgeOrdinal = 0; edgeOrdinal < input.projection.edges.length; edgeOrdinal += 1) {
        const edge = input.projection.edges[edgeOrdinal];
        await client.query(
          `insert into pmxt_shadow_router_edges
             (shadow_track_run_id, cluster_id, edge_ordinal, market_a_id,
              market_b_id, relation, confidence, eligible, exclusion_reason,
              kalshi_native_id, polymarket_native_id, payload)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (shadow_track_run_id, cluster_id, edge_ordinal) do nothing`,
          [
            trackRunId,
            edge.clusterId,
            edgeOrdinal,
            edge.marketAId,
            edge.marketBId,
            edge.relation,
            edge.confidence,
            edge.eligibleByDefault,
            edge.exclusionReason ?? null,
            edge.kalshiNativeId ?? null,
            edge.polymarketNativeId ?? null,
            JSON.stringify(edge),
          ]
        );
      }
    });
  }

  private async upsertTrackRun(
    client: PoolClient,
    input: {
      authoritativeScanRunId: string;
      shadowRunId: string;
      shadowRunAttemptId: string;
      track: "reads" | "router";
      status: string;
      cause: string;
      scope: unknown;
      authoritativeReceiptAt?: string;
      pmxtReceiptAt?: string;
      metadata: unknown;
    }
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `insert into pmxt_shadow_track_runs
         (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id,
          track, status, cause, scope, authoritative_receipt_at, pmxt_receipt_at, metadata)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz, $10::jsonb)
       on conflict (shadow_run_attempt_id, track) do update set status = excluded.status
       returning id`,
      [
        input.authoritativeScanRunId,
        input.shadowRunId,
        input.shadowRunAttemptId,
        input.track,
        input.status,
        input.cause,
        JSON.stringify(input.scope),
        input.authoritativeReceiptAt ?? null,
        input.pmxtReceiptAt ?? null,
        JSON.stringify(input.metadata),
      ]
    );
    return result.rows[0].id;
  }

  private async transaction(action: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await action(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
