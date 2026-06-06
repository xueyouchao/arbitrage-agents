import { Pool, PoolClient } from "pg";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { uuidFromStableKey } from "../shared/stable-id";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import {
  CompletedScanArtifacts,
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair,
  ScannerRepository
} from "./scanner-repository";
import { SCANNER_DB_POOL } from "./scanner-tokens";
import { ScanResult } from "./scanner-result";

@Injectable()
export class PostgresScannerRepository implements ScannerRepository, OnModuleDestroy {
  constructor(@Inject(SCANNER_DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async saveScanRun(scanRun: ScanResult): Promise<void> {
    await saveScanRun(this.pool, scanRun);
  }

  async saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await saveScanRun(client, artifacts.scanRun);
      await saveSnapshots(client, artifacts.scanRun.id, artifacts.snapshots);
      const marketIds = await saveNormalizedMarkets(client, artifacts.normalizedMarkets);
      const candidatePairIds = await saveCandidatePairs(client, artifacts.candidatePairs, marketIds);
      await saveOrderbookSnapshots(client, artifacts.orderbookSnapshots, marketIds);
      await saveOpportunities(client, artifacts.opportunities, candidatePairIds);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function saveScanRun(queryable: Queryable, scanRun: ScanResult): Promise<void> {
  await queryable.query(
    `insert into scan_runs (id, status, started_at, completed_at, metrics)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (id) do update set
       status = excluded.status,
       completed_at = excluded.completed_at,
       metrics = excluded.metrics`,
    [scanRun.id, scanRun.status, scanRun.startedAt, scanRun.completedAt ?? null, JSON.stringify(scanRun.metrics)]
  );
}

async function saveSnapshots(queryable: Queryable, scanRunId: string, snapshots: VenueMarketSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await queryable.query(
      `insert into venue_market_snapshots (scan_run_id, venue, venue_market_id, raw_payload, captured_at)
       values ($1, $2, $3, $4::jsonb, $5)`,
      [
        scanRunId,
        snapshot.venue,
        snapshot.venueMarketId,
        JSON.stringify({
          scannerTitle: snapshot.title,
          scannerRawResolutionText: snapshot.rawResolutionText,
          sourcePayload: snapshot.rawPayload
        }),
        snapshot.capturedAt
      ]
    );
  }
}

async function saveNormalizedMarkets(queryable: Queryable, markets: NormalizedMarket[]): Promise<Map<string, string>> {
  const idsByMarketId = new Map<string, string>();

  for (const market of markets) {
    const result = await queryable.query<{ id: string }>(
      `insert into normalized_markets (
        id, venue, venue_market_id, title, raw_resolution_text, topic, event_type,
        asset, threshold, operator, deadline, timezone, resolution_source,
        payoff_type, ambiguity_flags, confidence
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
      on conflict (venue, venue_market_id) do update set
        title = excluded.title,
        raw_resolution_text = excluded.raw_resolution_text,
        topic = excluded.topic,
        event_type = excluded.event_type,
        asset = excluded.asset,
        threshold = excluded.threshold,
        operator = excluded.operator,
        deadline = excluded.deadline,
        timezone = excluded.timezone,
        resolution_source = excluded.resolution_source,
        payoff_type = excluded.payoff_type,
        ambiguity_flags = excluded.ambiguity_flags,
        confidence = excluded.confidence
      returning id`,
      [
        uuidFromStableKey(market.id),
        market.venue,
        market.venueMarketId,
        market.title,
        market.rawResolutionText,
        market.topic,
        market.eventType,
        market.asset ?? null,
        market.threshold ?? null,
        market.operator ?? null,
        market.deadline ?? null,
        market.timezone ?? null,
        market.resolutionSource ?? null,
        market.payoffType,
        JSON.stringify(market.ambiguityFlags),
        market.confidence
      ]
    );
    idsByMarketId.set(market.id, result.rows[0].id);
  }

  return idsByMarketId;
}

async function saveCandidatePairs(
  queryable: Queryable,
  reviewedPairs: ReviewedCandidatePair[],
  marketIds: Map<string, string>
): Promise<Map<string, string>> {
  const idsByPairId = new Map<string, string>();

  for (const { pair, decision } of reviewedPairs) {
    const result = await queryable.query<{ id: string }>(
      `insert into candidate_pairs (id, kalshi_market_id, polymarket_market_id, equivalence_class, decision, reasons)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (kalshi_market_id, polymarket_market_id) do update set
         equivalence_class = excluded.equivalence_class,
         decision = excluded.decision,
         reasons = excluded.reasons
       returning id`,
      [
        uuidFromStableKey(pair.id),
        persistedId(marketIds, pair.kalshiMarket.id),
        persistedId(marketIds, pair.polymarketMarket.id),
        decision.equivalenceClass,
        decision.decision,
        JSON.stringify([...pair.reasons, ...decision.reasons])
      ]
    );
    idsByPairId.set(pair.id, result.rows[0].id);
  }

  return idsByPairId;
}

async function saveOrderbookSnapshots(
  queryable: Queryable,
  snapshots: OrderbookSnapshotArtifact[],
  marketIds: Map<string, string>
): Promise<void> {
  for (const snapshot of snapshots) {
    await queryable.query(
      `insert into orderbook_snapshots (
        id, scan_run_id, normalized_market_id, yes_ask, no_ask, yes_available_usd,
        no_available_usd, raw_payload, captured_at, stale
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      on conflict (id) do update set
        scan_run_id = excluded.scan_run_id,
        normalized_market_id = excluded.normalized_market_id,
        yes_ask = excluded.yes_ask,
        no_ask = excluded.no_ask,
        yes_available_usd = excluded.yes_available_usd,
        no_available_usd = excluded.no_available_usd,
        raw_payload = excluded.raw_payload,
        captured_at = excluded.captured_at,
        stale = excluded.stale`,
      [
        uuidFromStableKey(snapshot.id),
        snapshot.scanRunId,
        persistedId(marketIds, snapshot.normalizedMarketId),
        snapshot.yesAsk ?? null,
        snapshot.noAsk ?? null,
        snapshot.yesAvailableUsd,
        snapshot.noAvailableUsd,
        JSON.stringify(snapshot.rawPayload),
        snapshot.capturedAt,
        snapshot.stale
      ]
    );
  }
}

async function saveOpportunities(
  queryable: Queryable,
  opportunities: OpportunityWithSourceSnapshots[],
  candidatePairIds: Map<string, string>
): Promise<void> {
  for (const { opportunity, kalshiOrderbookSnapshotId, polymarketOrderbookSnapshotId } of opportunities) {
    await queryable.query(
      `insert into opportunities (
        id, candidate_pair_id, kalshi_orderbook_snapshot_id, polymarket_orderbook_snapshot_id,
        long_leg, hedge_leg, combined_cost, gross_edge, estimated_fees,
        estimated_slippage, net_edge, max_tradable_usd, equivalence_class,
        resolution_risk, fill_risk, detected_at, last_verified_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      on conflict (id) do update set
        kalshi_orderbook_snapshot_id = excluded.kalshi_orderbook_snapshot_id,
        polymarket_orderbook_snapshot_id = excluded.polymarket_orderbook_snapshot_id,
        long_leg = excluded.long_leg,
        hedge_leg = excluded.hedge_leg,
        combined_cost = excluded.combined_cost,
        gross_edge = excluded.gross_edge,
        estimated_fees = excluded.estimated_fees,
        estimated_slippage = excluded.estimated_slippage,
        net_edge = excluded.net_edge,
        max_tradable_usd = excluded.max_tradable_usd,
        equivalence_class = excluded.equivalence_class,
        resolution_risk = excluded.resolution_risk,
        fill_risk = excluded.fill_risk,
        last_verified_at = excluded.last_verified_at`,
      [
        uuidFromStableKey(opportunity.id),
        persistedId(candidatePairIds, opportunity.pairId),
        uuidFromStableKey(kalshiOrderbookSnapshotId),
        uuidFromStableKey(polymarketOrderbookSnapshotId),
        JSON.stringify(opportunity.longLeg),
        JSON.stringify(opportunity.hedgeLeg),
        opportunity.combinedCost,
        opportunity.grossEdge,
        opportunity.estimatedFees,
        opportunity.estimatedSlippage,
        opportunity.netEdge,
        opportunity.maxTradableUsd,
        opportunity.equivalenceClass,
        opportunity.resolutionRisk,
        opportunity.fillRisk,
        opportunity.detectedAt,
        opportunity.lastVerifiedAt
      ]
    );
  }
}

function persistedId(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`Missing persisted id for ${key}`);
  return id;
}

interface Queryable {
  query: Pool["query"] | PoolClient["query"];
}
