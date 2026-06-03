import { Pool } from "pg";
import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { CandidatePair } from "../matching/domain/candidate-pair";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import { ScannerRepository } from "./in-memory-scanner-repository";
import { ScanResult } from "./scanner-result";

export class PostgresScannerRepository implements ScannerRepository {
  private activeScanRunId?: string;

  constructor(private readonly pool: Pool) {}

  async saveScanRun(scanRun: ScanResult): Promise<void> {
    this.activeScanRunId = scanRun.id;
    await this.pool.query(
      `insert into scan_runs (id, status, started_at, completed_at, metrics)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (id) do update set
         status = excluded.status,
         completed_at = excluded.completed_at,
         metrics = excluded.metrics`,
      [scanRun.id, scanRun.status, scanRun.startedAt, scanRun.completedAt ?? null, JSON.stringify(scanRun.metrics)]
    );
  }

  async saveSnapshots(snapshots: VenueMarketSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await this.pool.query(
        `insert into venue_market_snapshots (scan_run_id, venue, venue_market_id, raw_payload, captured_at)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [this.activeScanRunId ?? null, snapshot.venue, snapshot.venueMarketId, JSON.stringify({ title: snapshot.title, rawResolutionText: snapshot.rawResolutionText, ...snapshot.rawPayload }), snapshot.capturedAt]
      );
    }
  }

  async saveNormalizedMarkets(markets: NormalizedMarket[]): Promise<void> {
    for (const market of markets) {
      await this.pool.query(
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
          confidence = excluded.confidence`,
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
    }
  }

  async saveCandidatePairs(pairs: CandidatePair[]): Promise<void> {
    for (const pair of pairs) {
      await this.pool.query(
        `insert into candidate_pairs (id, kalshi_market_id, polymarket_market_id, reasons)
         values ($1, $2, $3, $4::jsonb)
         on conflict (kalshi_market_id, polymarket_market_id) do update set
           id = excluded.id,
           reasons = excluded.reasons`,
        [
          uuidFromStableKey(pair.id),
          uuidFromStableKey(pair.kalshiMarket.id),
          uuidFromStableKey(pair.polymarketMarket.id),
          JSON.stringify(pair.reasons)
        ]
      );
    }
  }

  async saveOpportunities(opportunities: CrossVenueOpportunity[]): Promise<void> {
    for (const opportunity of opportunities) {
      await this.pool.query(
        `insert into opportunities (
          id, candidate_pair_id, long_leg, hedge_leg, combined_cost, gross_edge,
          estimated_fees, estimated_slippage, net_edge, max_tradable_usd,
          equivalence_class, resolution_risk, fill_risk, detected_at, last_verified_at
        ) values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        on conflict (id) do update set
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
          uuidFromStableKey(opportunity.pairId),
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
}


function uuidFromStableKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const char of key) {
    const code = char.charCodeAt(0);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x811c9dc5) >>> 0;
  }
  const tail = `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`.slice(0, 12);
  return `00000000-0000-4000-8000-${tail}`;
}
