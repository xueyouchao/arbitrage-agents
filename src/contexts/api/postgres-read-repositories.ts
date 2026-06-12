import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import {
  MarketReadModel,
  MarketReadRepository,
  OpportunityReadModel,
  OpportunityReadRepository,
  ScanRunReadModel,
  ScanRunReadRepository
} from "./read-models";

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

  async listOpportunities(): Promise<OpportunityReadModel[]> {
    const result = await this.pool.query<OpportunityRow>(`
      select id,
             candidate_pair_id,
             kalshi_orderbook_snapshot_id,
             polymarket_orderbook_snapshot_id,
             long_leg,
             hedge_leg,
             combined_cost,
             gross_edge,
             estimated_fees,
             estimated_slippage,
             net_edge,
             max_tradable_usd,
             notional_edges,
             equivalence_class,
             resolution_risk,
             fill_risk,
             liquidity_risk,
             venue_risk,
             equivalence_risk,
             data_staleness_ms,
             opportunity_age_ms,
             detected_at,
             last_verified_at,
             calculation_version,
             config_version
      from opportunities
      order by detected_at desc
      limit 100
    `);

    return result.rows.map(toOpportunity);
  }

  async getOpportunity(id: string): Promise<OpportunityReadModel | undefined> {
    const result = await this.pool.query<OpportunityRow>(`
      select id,
             candidate_pair_id,
             kalshi_orderbook_snapshot_id,
             polymarket_orderbook_snapshot_id,
             long_leg,
             hedge_leg,
             combined_cost,
             gross_edge,
             estimated_fees,
             estimated_slippage,
             net_edge,
             max_tradable_usd,
             notional_edges,
             equivalence_class,
             resolution_risk,
             fill_risk,
             liquidity_risk,
             venue_risk,
             equivalence_risk,
             data_staleness_ms,
             opportunity_age_ms,
             detected_at,
             last_verified_at,
             calculation_version,
             config_version
      from opportunities
      where id = $1
      limit 1
    `, [id]);

    return result.rows[0] ? toOpportunity(result.rows[0]) : undefined;
  }

  async listMarkets(): Promise<MarketReadModel[]> {
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
      opportunitiesFound: numberFromUnknown(metrics.opportunitiesFound),
      failureCategory: toFailureCategory(metrics.failureCategory),
      failureReason: stringFromUnknown(metrics.failureReason)
    };
  }
}

interface OpportunityRow {
  id: string;
  candidate_pair_id: string;
  kalshi_orderbook_snapshot_id: string | null;
  polymarket_orderbook_snapshot_id: string | null;
  long_leg: OpportunityReadModel["longLeg"];
  hedge_leg: OpportunityReadModel["hedgeLeg"];
  combined_cost: string;
  gross_edge: string;
  estimated_fees: string;
  estimated_slippage: string;
  net_edge: string;
  max_tradable_usd: string;
  notional_edges: OpportunityReadModel["notionalEdges"] | string;
  equivalence_class: OpportunityReadModel["equivalenceClass"];
  resolution_risk: OpportunityReadModel["resolutionRisk"];
  fill_risk: OpportunityReadModel["fillRisk"];
  liquidity_risk: OpportunityReadModel["liquidityRisk"];
  venue_risk: OpportunityReadModel["venueRisk"];
  equivalence_risk: OpportunityReadModel["equivalenceRisk"];
  data_staleness_ms: number;
  opportunity_age_ms: number;
  detected_at: Date | string;
  last_verified_at: Date | string;
  calculation_version: string;
  config_version: string;
}

interface MarketRow {
  id: string;
  venue: MarketReadModel["venue"];
  venue_market_id: string;
  title: string;
  raw_resolution_text: string;
  topic: MarketReadModel["topic"];
  event_type: MarketReadModel["eventType"];
  asset: MarketReadModel["asset"] | null;
  threshold: string | null;
  operator: MarketReadModel["operator"] | null;
  deadline: Date | string | null;
  timezone: string | null;
  resolution_source: string | null;
  payoff_type: MarketReadModel["payoffType"];
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

function toOpportunity(row: OpportunityRow): OpportunityReadModel {
  return {
    id: row.id,
    pairId: row.candidate_pair_id,
    kalshiOrderbookSnapshotId: row.kalshi_orderbook_snapshot_id ?? undefined,
    polymarketOrderbookSnapshotId: row.polymarket_orderbook_snapshot_id ?? undefined,
    longLeg: row.long_leg,
    hedgeLeg: row.hedge_leg,
    combinedCost: Number(row.combined_cost),
    grossEdge: Number(row.gross_edge),
    estimatedFees: Number(row.estimated_fees),
    estimatedSlippage: Number(row.estimated_slippage),
    netEdge: Number(row.net_edge),
    maxTradableUsd: Number(row.max_tradable_usd),
    notionalEdges: toNotionalEdges(row.notional_edges),
    equivalenceClass: row.equivalence_class,
    resolutionRisk: row.resolution_risk,
    fillRisk: row.fill_risk,
    liquidityRisk: row.liquidity_risk,
    venueRisk: row.venue_risk,
    equivalenceRisk: row.equivalence_risk,
    dataStalenessMs: Number(row.data_staleness_ms),
    opportunityAgeMs: Number(row.opportunity_age_ms),
    detectedAt: toIso(row.detected_at),
    lastVerifiedAt: toIso(row.last_verified_at),
    calculationVersion: row.calculation_version,
    configVersion: row.config_version
  };
}

function toMarket(row: MarketRow): MarketReadModel {
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

function toNotionalEdges(value: OpportunityRow["notional_edges"]): OpportunityReadModel["notionalEdges"] {
  const parsed = parseNotionalEdges(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((edge) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) return [];
    const record = edge as Record<string, unknown>;
    const normalized = {
      targetNotionalUsd: Number(record.targetNotionalUsd),
      grossEdge: Number(record.grossEdge),
      estimatedFees: Number(record.estimatedFees),
      estimatedSlippage: Number(record.estimatedSlippage),
      netEdge: Number(record.netEdge),
      fillable: record.fillable
    };
    return Number.isFinite(normalized.targetNotionalUsd) &&
      Number.isFinite(normalized.grossEdge) &&
      Number.isFinite(normalized.estimatedFees) &&
      Number.isFinite(normalized.estimatedSlippage) &&
      Number.isFinite(normalized.netEdge) &&
      typeof normalized.fillable === "boolean"
      ? [normalized as OpportunityReadModel["notionalEdges"][number]]
      : [];
  });
}

function parseNotionalEdges(value: OpportunityRow["notional_edges"]): unknown {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return [];
  }
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

function toFailureCategory(value: unknown): ScanRunReadModel["failureCategory"] {
  return value === "fetch" || value === "processing" || value === "persistence" ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
