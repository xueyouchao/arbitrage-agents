import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import {
  MarketReadRepository,
  OpportunityReadRepository,
  ScanRunReadModel,
  ScanRunReadRepository
} from "./read-models";
import { CrossVenueOpportunity } from "../arbitrage/domain/opportunity";
import { NormalizedMarket } from "../matching/domain/normalized-market";

@Injectable()
export class PostgresReadRepositories
  implements OpportunityReadRepository, MarketReadRepository, ScanRunReadRepository, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async listOpportunities(): Promise<CrossVenueOpportunity[]> {
    const result = await this.pool.query<OpportunityRow>(`
      select id,
             candidate_pair_id,
             long_leg,
             hedge_leg,
             combined_cost,
             gross_edge,
             estimated_fees,
             estimated_slippage,
             net_edge,
             max_tradable_usd,
             equivalence_class,
             resolution_risk,
             fill_risk,
             detected_at,
             last_verified_at
      from opportunities
      order by detected_at desc
      limit 100
    `);

    return result.rows.map(toOpportunity);
  }

  async getOpportunity(id: string): Promise<CrossVenueOpportunity | undefined> {
    const result = await this.pool.query<OpportunityRow>(`
      select id,
             candidate_pair_id,
             long_leg,
             hedge_leg,
             combined_cost,
             gross_edge,
             estimated_fees,
             estimated_slippage,
             net_edge,
             max_tradable_usd,
             equivalence_class,
             resolution_risk,
             fill_risk,
             detected_at,
             last_verified_at
      from opportunities
      where id = $1
      limit 1
    `, [id]);

    return result.rows[0] ? toOpportunity(result.rows[0]) : undefined;
  }

  async listMarkets(): Promise<NormalizedMarket[]> {
    const result = await this.pool.query<MarketRow>(`
      select id,
             venue,
             venue_market_id,
             title,
             raw_resolution_text,
             topic,
             event_type,
             asset,
             threshold,
             operator,
             deadline,
             timezone,
             resolution_source,
             payoff_type,
             ambiguity_flags,
             confidence
      from normalized_markets
      order by created_at desc
      limit 500
    `);

    return result.rows.map(toMarket);
  }

  async getLatestScanRun(): Promise<ScanRunReadModel> {
    const result = await this.pool.query<ScanRunRow>(`
      select id,
             status,
             started_at,
             completed_at,
             metrics
      from scan_runs
      order by started_at desc
      limit 1
    `);

    if (!result.rows[0]) {
      return {
        id: "none",
        status: "failed",
        startedAt: new Date(0).toISOString(),
        marketsScanned: 0,
        opportunitiesFound: 0
      };
    }

    const row = result.rows[0];
    const metrics = row.metrics ?? {};
    return {
      id: row.id,
      status: toScanRunStatus(row.status),
      startedAt: toIso(row.started_at),
      completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
      marketsScanned: numberFromUnknown(metrics.marketsScanned),
      opportunitiesFound: numberFromUnknown(metrics.opportunitiesFound)
    };
  }
}

interface OpportunityRow {
  id: string;
  candidate_pair_id: string;
  long_leg: CrossVenueOpportunity["longLeg"];
  hedge_leg: CrossVenueOpportunity["hedgeLeg"];
  combined_cost: string;
  gross_edge: string;
  estimated_fees: string;
  estimated_slippage: string;
  net_edge: string;
  max_tradable_usd: string;
  equivalence_class: CrossVenueOpportunity["equivalenceClass"];
  resolution_risk: CrossVenueOpportunity["resolutionRisk"];
  fill_risk: CrossVenueOpportunity["fillRisk"];
  detected_at: Date | string;
  last_verified_at: Date | string;
}

interface MarketRow {
  id: string;
  venue: NormalizedMarket["venue"];
  venue_market_id: string;
  title: string;
  raw_resolution_text: string;
  topic: NormalizedMarket["topic"];
  event_type: NormalizedMarket["eventType"];
  asset: NormalizedMarket["asset"] | null;
  threshold: string | null;
  operator: NormalizedMarket["operator"] | null;
  deadline: Date | string | null;
  timezone: string | null;
  resolution_source: string | null;
  payoff_type: NormalizedMarket["payoffType"];
  ambiguity_flags: string[];
  confidence: string;
}

interface ScanRunRow {
  id: string;
  status: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  metrics: Record<string, unknown> | null;
}

function toOpportunity(row: OpportunityRow): CrossVenueOpportunity {
  return {
    id: row.id,
    pairId: row.candidate_pair_id,
    longLeg: row.long_leg,
    hedgeLeg: row.hedge_leg,
    combinedCost: Number(row.combined_cost),
    grossEdge: Number(row.gross_edge),
    estimatedFees: Number(row.estimated_fees),
    estimatedSlippage: Number(row.estimated_slippage),
    netEdge: Number(row.net_edge),
    maxTradableUsd: Number(row.max_tradable_usd),
    equivalenceClass: row.equivalence_class,
    resolutionRisk: row.resolution_risk,
    fillRisk: row.fill_risk,
    detectedAt: toIso(row.detected_at),
    lastVerifiedAt: toIso(row.last_verified_at)
  };
}

function toMarket(row: MarketRow): NormalizedMarket {
  return {
    id: row.id,
    venue: row.venue,
    venueMarketId: row.venue_market_id,
    title: row.title,
    rawResolutionText: row.raw_resolution_text,
    topic: row.topic,
    eventType: row.event_type,
    asset: row.asset ?? undefined,
    threshold: row.threshold === null ? undefined : Number(row.threshold),
    operator: row.operator ?? undefined,
    deadline: row.deadline ? toIso(row.deadline) : undefined,
    timezone: row.timezone ?? undefined,
    resolutionSource: row.resolution_source ?? undefined,
    payoffType: row.payoff_type,
    ambiguityFlags: row.ambiguity_flags,
    confidence: Number(row.confidence)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toScanRunStatus(value: string): ScanRunReadModel["status"] {
  return value === "succeeded" || value === "running" || value === "failed" ? value : "failed";
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
