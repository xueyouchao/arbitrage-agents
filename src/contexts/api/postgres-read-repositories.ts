import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "../shared/database/database-tokens";
import {
  MarketReadModel,
  MarketReadRepository,
  OpportunityFilters,
  OpportunityReadModel,
  OpportunityReadRepository,
  OpportunitySort,
  PaginatedResponse,
  PaginationParams,
  PaperTradeLegFillReadModel,
  PaperTradeSimulationReadModel,
  PaperTradeSimulationReadRepository,
  ScanRunReadModel,
  ScanRunReadRepository
} from "./read-models";

// The shared `DATABASE_POOL` is injected; this repository no longer
// constructs its own `Pool` or owns `pool.end()`. Pool lifetime is owned
// solely by `DatabasePoolHolder` in the shared database infrastructure
// module, which calls `pool.end()` once during `onApplicationShutdown`
// after every consumer (api + scanner) has finished its last query.
@Injectable()
export class PostgresReadRepositories
  implements OpportunityReadRepository, MarketReadRepository, ScanRunReadRepository, PaperTradeSimulationReadRepository
{
  private readonly pool: Pool;

  constructor(@Inject(DATABASE_POOL) pool: Pool) {
    this.pool = pool;
  }

  async listOpportunities(params?: {
    pagination?: PaginationParams;
    filters?: OpportunityFilters;
    sort?: OpportunitySort;
  }): Promise<PaginatedResponse<OpportunityReadModel>> {
    const pagination = params?.pagination ?? { offset: 0, limit: 20 };
    const filters = params?.filters ?? {};
    const sort = params?.sort ?? { field: "detectedAt", order: "desc" };

    const whereClauses: string[] = [];
    const queryParams: any[] = [];
    let paramIndex = 1;

    if (filters.equivalenceClass) {
      whereClauses.push(`equivalence_class = $${paramIndex}`);
      queryParams.push(filters.equivalenceClass);
      paramIndex++;
    }
    if (filters.minNetEdge !== undefined) {
      whereClauses.push(`net_edge >= $${paramIndex}`);
      queryParams.push(filters.minNetEdge);
      paramIndex++;
    }
    if (filters.maxDataStalenessMs !== undefined) {
      whereClauses.push(`data_staleness_ms <= $${paramIndex}`);
      queryParams.push(filters.maxDataStalenessMs);
      paramIndex++;
    }
    if (filters.resolutionRisk) {
      whereClauses.push(`resolution_risk = $${paramIndex}`);
      queryParams.push(filters.resolutionRisk);
      paramIndex++;
    }
    if (filters.fillRisk) {
      whereClauses.push(`fill_risk = $${paramIndex}`);
      queryParams.push(filters.fillRisk);
      paramIndex++;
    }
    if (filters.humanReviewFlag) {
      whereClauses.push(`human_review_flag = $${paramIndex}`);
      queryParams.push(filters.humanReviewFlag);
      paramIndex++;
    }

    const whereClause = whereClauses.length > 0 ? `where ${whereClauses.join(" and ")}` : "";

    const sortFieldMap: Record<string, string> = {
      detectedAt: "detected_at",
      netEdge: "net_edge",
      opportunityAgeMs: "opportunity_age_ms",
      equivalenceClass: "equivalence_class"
    };
    const dbSortField = sortFieldMap[sort.field] || "detected_at";
    const sortOrder = sort.order === "asc" ? "asc" : "desc";

    const countQuery = `
      select count(*) as total
      from opportunities
      ${whereClause}
    `;
    const countResult = await this.pool.query<{ total: string }>(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].total, 10);

    const dataQuery = `
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
             theoretical_combined_cost,
             theoretical_gross_edge,
             theoretical_net_edge,
             executable_size_usd,
             executable_combined_cost,
             executable_gross_edge,
             executable_net_edge,
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
             first_detected_at,
             last_verified_at,
             calculation_version,
             config_version,
             human_review_flag,
             human_review_notes
      from opportunities
      ${whereClause}
      order by ${dbSortField} ${sortOrder}
      limit $${paramIndex} offset $${paramIndex + 1}
    `;
    const dataParams = [...queryParams, pagination.limit, pagination.offset];
    const result = await this.pool.query<OpportunityRow>(dataQuery, dataParams);

    const data = result.rows.map(toOpportunity);
    const hasMore = pagination.offset + data.length < total;

    return {
      data,
      pagination: {
        offset: pagination.offset,
        limit: pagination.limit,
        total,
        hasMore
      }
    };
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
             theoretical_combined_cost,
             theoretical_gross_edge,
             theoretical_net_edge,
             executable_size_usd,
             executable_combined_cost,
             executable_gross_edge,
             executable_net_edge,
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
             first_detected_at,
             last_verified_at,
             calculation_version,
             config_version,
             human_review_flag,
             human_review_notes
      from opportunities
      where id = $1
      limit 1
    `, [id]);

    return result.rows[0] ? toOpportunity(result.rows[0]) : undefined;
  }

  async listMarkets(params?: {
    pagination?: PaginationParams;
  }): Promise<PaginatedResponse<MarketReadModel>> {
    const pagination = params?.pagination ?? { offset: 0, limit: 50 };

    const countResult = await this.pool.query<{ total: string }>(
      `select count(*) as total from normalized_markets`
    );
    const total = parseInt(countResult.rows[0].total, 10);

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
      limit $1 offset $2
    `, [pagination.limit, pagination.offset]);

    const data = result.rows.map(toMarket);
    const hasMore = pagination.offset + data.length < total;

    return {
      data,
      pagination: {
        offset: pagination.offset,
        limit: pagination.limit,
        total,
        hasMore
      }
    };
  }

  async listPaperTradeSimulations(opportunityId: string): Promise<PaperTradeSimulationReadModel[]> {
    const result = await this.pool.query<PaperTradeSimulationRow>(`
      select id,
             opportunity_id,
             simulated_at,
             target_notional_usd,
             long_leg,
             hedge_leg,
             adverse_selection_bps,
             partial_fill,
             residual_exposure_usd,
             combined_cost,
             gross_edge,
             net_edge,
             config_version,
             calculation_version
      from paper_trade_simulations
      where opportunity_id = $1
      order by simulated_at desc, target_notional_usd asc
      limit 100
    `, [opportunityId]);

    return result.rows.map(toPaperTradeSimulation);
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
  theoretical_combined_cost: string | null;
  theoretical_gross_edge: string | null;
  theoretical_net_edge: string | null;
  executable_size_usd: string | null;
  executable_combined_cost: string | null;
  executable_gross_edge: string | null;
  executable_net_edge: string | null;
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
  first_detected_at: Date | string | null;
  last_verified_at: Date | string;
  calculation_version: string;
  config_version: string;
  human_review_flag: "pending" | "approved" | "rejected" | null;
  human_review_notes: string | null;
}

interface MarketRow {
  id: string;
  venue: MarketReadModel["venue"];
  venue_market_id: string;
  title: string;
  raw_resolution_text: string;
  topic: MarketReadModel["topic"];
  event_type: MarketReadModel["eventType"];
  asset: string | null;
  threshold: string | null;
  operator: MarketReadModel["operator"] | null;
  deadline: Date | string | null;
  timezone: string | null;
  resolution_source: string | null;
  payoff_type: MarketReadModel["payoffType"];
  ambiguity_flags: string[];
  confidence: string;
}

interface PaperTradeSimulationRow {
  id: string;
  opportunity_id: string;
  simulated_at: Date | string;
  target_notional_usd: string;
  long_leg: PaperTradeLegFillReadModel;
  hedge_leg: PaperTradeLegFillReadModel;
  adverse_selection_bps: string;
  partial_fill: boolean;
  residual_exposure_usd: string;
  combined_cost: string;
  gross_edge: string;
  net_edge: string;
  config_version: string;
  calculation_version: string;
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
    theoreticalCombinedCost: Number(row.theoretical_combined_cost ?? row.combined_cost),
    theoreticalGrossEdge: Number(row.theoretical_gross_edge ?? row.gross_edge),
    theoreticalNetEdge: Number(row.theoretical_net_edge ?? row.net_edge),
    executableSizeUsd: Number(row.executable_size_usd ?? row.max_tradable_usd),
    executableCombinedCost: Number(row.executable_combined_cost ?? row.combined_cost),
    executableGrossEdge: Number(row.executable_gross_edge ?? row.gross_edge),
    executableNetEdge: Number(row.executable_net_edge ?? row.net_edge),
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
    firstDetectedAt: toIso(row.first_detected_at ?? row.detected_at),
    lastVerifiedAt: toIso(row.last_verified_at),
    calculationVersion: row.calculation_version,
    configVersion: row.config_version,
    humanReviewFlag: row.human_review_flag ?? undefined,
    humanReviewNotes: row.human_review_notes ?? undefined
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

function toPaperTradeSimulation(row: PaperTradeSimulationRow): PaperTradeSimulationReadModel {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    simulatedAt: toIso(row.simulated_at),
    targetNotionalUsd: Number(row.target_notional_usd),
    longLegFill: row.long_leg,
    hedgeLegFill: row.hedge_leg,
    adverseSelectionBps: Number(row.adverse_selection_bps),
    partialFill: row.partial_fill,
    residualExposureUsd: Number(row.residual_exposure_usd),
    combinedCost: Number(row.combined_cost),
    grossEdge: Number(row.gross_edge),
    netEdge: Number(row.net_edge),
    configVersion: row.config_version,
    calculationVersion: row.calculation_version
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

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toScanRunStatus(value: string): ScanRunReadModel["status"] {
  // Phase 4: the worker can now leave a scan in `abandoned` status;
  // surface it on the read API so an operator can distinguish a
  // failure from a worker that simply never reported back. Unknown
  // values fall back to `failed` for forward-compatibility.
  if (value === "succeeded" || value === "running" || value === "failed" || value === "abandoned") return value;
  return "failed";
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toFailureCategory(value: unknown): ScanRunReadModel["failureCategory"] {
  if (value === "fetch" || value === "processing" || value === "persistence" || value === "abandoned") return value;
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
