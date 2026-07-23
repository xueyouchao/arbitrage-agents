import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Phase 4: heartbeat is the latest step transition timestamp the worker
  // has acknowledged. The abandoned-scan detector compares it against
  // `abandonedAfterMs` from config; scans whose heartbeat is older than
  // the threshold are flipped to `abandoned` so a fresh run can take over.
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  metrics: jsonb("metrics").notNull().default({}),
  // Phase 4 Finding #6: per-worker lease. The worker stamps its own
  // UUID on every scan it creates so the abandoned-scan detector can
  // skip runs owned by the active worker process. NULL for legacy
  // scans created before this column existed (treated as abandoned
  // by the detector for backward compatibility).
  workerId: text("worker_id")
});

export const venueMarketSnapshots = pgTable("venue_market_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanRunId: uuid("scan_run_id").references(() => scanRuns.id),
  venue: text("venue").notNull(),
  venueMarketId: text("venue_market_id").notNull(),
  rawPayload: jsonb("raw_payload").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow()
});

export const normalizedMarkets = pgTable(
  "normalized_markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venue: text("venue").notNull(),
    venueMarketId: text("venue_market_id").notNull(),
    title: text("title").notNull(),
    rawResolutionText: text("raw_resolution_text").notNull(),
    topic: text("topic").notNull(),
    eventType: text("event_type").notNull(),
    asset: text("asset"),
    threshold: numeric("threshold"),
    operator: text("operator"),
    deadline: timestamp("deadline", { withTimezone: true }),
    timezone: text("timezone"),
    resolutionSource: text("resolution_source"),
    payoffType: text("payoff_type").notNull(),
    ambiguityFlags: jsonb("ambiguity_flags").notNull().default([]),
    confidence: numeric("confidence").notNull(),
    llmEvaluationId: uuid("llm_evaluation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("normalized_markets_venue_market_unique").on(table.venue, table.venueMarketId)]
);

export const candidatePairs = pgTable(
  "candidate_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kalshiMarketId: uuid("kalshi_market_id").references(() => normalizedMarkets.id).notNull(),
    polymarketMarketId: uuid("polymarket_market_id").references(() => normalizedMarkets.id).notNull(),
    equivalenceClass: text("equivalence_class"),
    decision: text("decision"),
    reasons: jsonb("reasons").notNull().default([]),
    // Issue #13: the optional LLM evaluation FK is intentionally NOT a
    // hard foreign key constraint. A test, an alternate provider, or a
    // future deployment may back the scanner with a different LLM
    // evaluation repository. The audit link is preserved as a plain UUID
    // and the optional LLM metadata must never fail scan persistence.
    llmEvaluationId: uuid("llm_evaluation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("candidate_pairs_market_unique").on(table.kalshiMarketId, table.polymarketMarketId)]
);

export const llmEvaluations = pgTable(
  "llm_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskType: text("task_type").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    model: text("model").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    parsedOutput: jsonb("parsed_output"),
    status: text("status").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd"),
    latencyMs: integer("latency_ms"),
    // Persisted schema version of the parsed output. The cache-version
    // invariant only works end-to-end if this value round-trips through
    // the repository (issue #12, blocker follow-up).
    payloadSchemaVersion: text("payload_schema_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("llm_evaluations_cache_unique").on(table.taskType, table.inputHash, table.promptVersion, table.model)]
);

export const orderbookSnapshots = pgTable(
  "orderbook_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id),
    normalizedMarketId: uuid("normalized_market_id").references(() => normalizedMarkets.id).notNull(),
    yesAsk: numeric("yes_ask"),
    noAsk: numeric("no_ask"),
    yesAvailableUsd: numeric("yes_available_usd").notNull(),
    noAvailableUsd: numeric("no_available_usd").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    stale: boolean("stale").notNull().default(false)
  },
  (table) => [
    check("orderbook_yes_ask_range", sql`${table.yesAsk} is null or (${table.yesAsk} > 0 and ${table.yesAsk} < 1)`),
    check("orderbook_no_ask_range", sql`${table.noAsk} is null or (${table.noAsk} > 0 and ${table.noAsk} < 1)`),
    check("orderbook_yes_available_nonnegative", sql`${table.yesAvailableUsd} >= 0`),
    check("orderbook_no_available_nonnegative", sql`${table.noAvailableUsd} >= 0`)
  ]
);

export const opportunities = pgTable("opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  candidatePairId: uuid("candidate_pair_id").references(() => candidatePairs.id).notNull(),
  kalshiOrderbookSnapshotId: uuid("kalshi_orderbook_snapshot_id").references(() => orderbookSnapshots.id),
  polymarketOrderbookSnapshotId: uuid("polymarket_orderbook_snapshot_id").references(() => orderbookSnapshots.id),
  longLeg: jsonb("long_leg").notNull(),
  hedgeLeg: jsonb("hedge_leg").notNull(),
  combinedCost: numeric("combined_cost").notNull(),
  grossEdge: numeric("gross_edge").notNull(),
  estimatedFees: numeric("estimated_fees").notNull(),
  estimatedSlippage: numeric("estimated_slippage").notNull(),
  netEdge: numeric("net_edge").notNull(),
  theoreticalCombinedCost: numeric("theoretical_combined_cost").notNull().default("0"),
  theoreticalGrossEdge: numeric("theoretical_gross_edge").notNull().default("0"),
  theoreticalNetEdge: numeric("theoretical_net_edge").notNull().default("0"),
  executableSizeUsd: numeric("executable_size_usd").notNull().default("0"),
  executableCombinedCost: numeric("executable_combined_cost").notNull().default("0"),
  executableGrossEdge: numeric("executable_gross_edge").notNull().default("0"),
  executableNetEdge: numeric("executable_net_edge").notNull().default("0"),
  maxTradableUsd: numeric("max_tradable_usd").notNull(),
  notionalEdges: jsonb("notional_edges").notNull().default(sql`'[]'::jsonb`),
  equivalenceClass: text("equivalence_class").notNull(),
  resolutionRisk: text("resolution_risk").notNull(),
  fillRisk: text("fill_risk").notNull(),
  liquidityRisk: text("liquidity_risk").notNull().default("high"),
  venueRisk: text("venue_risk").notNull().default("high"),
  equivalenceRisk: text("equivalence_risk").notNull().default("high"),
  dataStalenessMs: integer("data_staleness_ms").notNull().default(0),
  opportunityAgeMs: integer("opportunity_age_ms").notNull().default(0),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  // Phase 3 #6: immutable first-detection timestamp. Distinct from
  // `detectedAt` (current scan's detection) so `opportunityAgeMs` can
  // reflect the time since the opportunity was first ever seen, not
  // since the most recent scan re-verified it.
  firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),
  calculationVersion: text("calculation_version").notNull().default("unknown"),
  configVersion: text("config_version").notNull().default("unknown"),
  // Phase 5: human-review workflow flags for production monitoring
  humanReviewFlag: text("human_review_flag"),
  humanReviewNotes: text("human_review_notes")
});

export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id).notNull(),
  channel: text("channel").notNull(),
  payload: jsonb("payload").notNull(),
  emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull().defaultNow()
});

// Phase 4: per-step execution trail for resumable scans. The
// orchestrator keeps history: a retried step appends a new row with
// attempt = N+1 rather than overwriting the prior status, so an
// operator can read the full retry trail. The latest row for
// (scan_run_id, step_name) is the authoritative state; the orchestrator
// queries it via the highest attempt. A unique index on
// (scan_run_id, step_name, attempt) ensures concurrent workers cannot
// mint the same attempt number; the insert loop retries on a unique
// violation so transient races converge safely.
export const scanSteps = pgTable(
  "scan_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id, { onDelete: "cascade" }).notNull(),
    stepName: text("step_name").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(1),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata").notNull().default({})
  },
  (table) => [
    index("scan_steps_status_idx").on(table.status),
    index("scan_steps_run_idx").on(table.scanRunId),
    index("scan_steps_run_name_started_at_idx").on(table.scanRunId, table.stepName, table.startedAt),
    uniqueIndex("scan_steps_run_name_attempt_unique").on(table.scanRunId, table.stepName, table.attempt)
  ]
);

// Phase 3 #6: paper-trade simulation records. The scanner runs the
// `PaperTradeSimulator` over every emitted opportunity and persists one
// row per target notional. The composite index on (opportunity_id,
// simulated_at desc) supports the "latest sims for this opportunity"
// read pattern used by operator dashboards. Cascade delete from
// `opportunities` keeps the audit trail consistent if an opportunity
// is ever removed.
export const paperTradeSimulations = pgTable(
  "paper_trade_simulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "cascade" }).notNull(),
    simulatedAt: timestamp("simulated_at", { withTimezone: true }).notNull(),
    targetNotionalUsd: numeric("target_notional_usd", { precision: 18, scale: 4 }).notNull(),
    longLeg: jsonb("long_leg").notNull(),
    hedgeLeg: jsonb("hedge_leg").notNull(),
    adverseSelectionBps: numeric("adverse_selection_bps", { precision: 10, scale: 4 }).notNull(),
    partialFill: boolean("partial_fill").notNull(),
    residualExposureUsd: numeric("residual_exposure_usd", { precision: 18, scale: 4 }).notNull(),
    combinedCost: numeric("combined_cost", { precision: 18, scale: 8 }).notNull(),
    grossEdge: numeric("gross_edge", { precision: 18, scale: 8 }).notNull(),
    netEdge: numeric("net_edge", { precision: 18, scale: 8 }).notNull(),
    configVersion: text("config_version").notNull(),
    calculationVersion: text("calculation_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("paper_trade_simulations_opportunity_simulated_at_idx").on(table.opportunityId, table.simulatedAt)
  ]
);

// Issue #79: execution-state tables. The execution orchestrator records every
// submitted order, every (possibly partial) fill, and the resulting position
// linking the two venue legs so #80 can unwind partials.
//
// `orders` holds one row per leg submission. `venue` distinguishes kalshi vs
// polymarket; `market` is the ticker (kalshi) or token id (polymarket).
// `status` is the orchestrator's own lifecycle value
// (pending/filled/cancelled/failed), independent of each venue's raw order
// status string.
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venue: text("venue").notNull(),
    market: text("market").notNull(),
    side: text("side").notNull(),
    price: numeric("price").notNull(),
    size: numeric("size").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("orders_status_idx").on(table.status)]
);

// `fills` records the realised fill for an order once the venue reports back.
// One row per (order, fill event); `fills` link back to `orders` via FK.
export const fills = pgTable(
  "fills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    fillPrice: numeric("fill_price").notNull(),
    fillSize: numeric("fill_size").notNull(),
    filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("fills_order_id_idx").on(table.orderId)]
);

// `positions` ties the two legs of a single cross-venue opportunity together.
// `opportunityId` is the id of the CrossVenueOpportunity that was executed.
// `kalshiOrderId`/`polyOrderId` reference the recorded `orders` rows.
// `status` is open (both legs filled), partial (only one filled — #80 unwinds),
// exposed (one leg filled, the other still in-flight/outstanding), or closed
// (fully unwound). PnL starts at 0 and is updated by later P&L roll-ups.
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    opportunityId: text("opportunity_id").notNull(),
    kalshiOrderId: uuid("kalshi_order_id").references(() => orders.id),
    polyOrderId: uuid("poly_order_id").references(() => orders.id),
    status: text("status").notNull(),
    pnl: numeric("pnl").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("positions_status_idx").on(table.status)]
);

// Issue #93: PMXT shadow evaluation lease table. Each row represents one
// claim of an authoritative scan run by a shadow worker. The logical-run
// lease prevents duplicate shadow runs and preserves attempt history so
// failed or partial shadow runs can be retried safely.
export const pmxtShadowRunAttempts = pgTable(
  "pmxt_shadow_run_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowRunId: uuid("shadow_run_id").notNull(),
    authoritativeScanRunId: uuid("authoritative_scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
    workerId: text("worker_id").notNull(),
    status: text("status").notNull().default("claimed"),
    retryReason: text("retry_reason"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    maxAttempts: integer("max_attempts").notNull().default(5),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("pmxt_shadow_attempts_scan_idx").on(table.authoritativeScanRunId),
    index("pmxt_shadow_attempts_worker_idx").on(table.workerId),
    index("pmxt_shadow_attempts_leased_until_idx").on(table.leasedUntil),
    index("pmxt_shadow_attempts_next_retry_idx").on(table.nextRetryAt),
    uniqueIndex("pmxt_shadow_attempts_scan_attempt_unique").on(table.authoritativeScanRunId, table.attemptNumber)
  ]
);

// Issue #96: Shadow-only parity tables. Each row links an authoritative scan
// run and a shadow run attempt, preserving complete provenance without
// touching production candidate_pairs, opportunities, alerts, positions, or
// execution tables. The shadow_run_id is NOT a foreign key to
// pmxt_shadow_run_attempts.shadow_run_id (which is non-unique); instead
// shadow_run_attempt_id FKs to pmxt_shadow_run_attempts.id for safe linkage.
export const pmxtShadowCandidates = pgTable(
  "pmxt_shadow_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authoritativeScanRunId: uuid("authoritative_scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    shadowRunId: uuid("shadow_run_id").notNull(),
    shadowRunAttemptId: uuid("shadow_run_attempt_id")
      .references(() => pmxtShadowRunAttempts.id, { onDelete: "cascade" })
      .notNull(),
    candidatePairId: text("candidate_pair_id").notNull(),
    kalshiMarketId: text("kalshi_market_id").notNull(),
    polymarketMarketId: text("polymarket_market_id").notNull(),
    equivalenceClass: text("equivalence_class"),
    decision: text("decision"),
    reasons: jsonb("reasons").notNull().default([]),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("pmxt_shadow_candidates_scan_idx").on(table.authoritativeScanRunId),
    index("pmxt_shadow_candidates_shadow_run_idx").on(table.shadowRunId),
    index("pmxt_shadow_candidates_attempt_idx").on(table.shadowRunAttemptId),
    uniqueIndex("pmxt_shadow_candidates_scan_run_pair_unique").on(
      table.authoritativeScanRunId,
      table.shadowRunId,
      table.shadowRunAttemptId,
      table.candidatePairId
    )
  ]
);

export const pmxtShadowOpportunities = pgTable(
  "pmxt_shadow_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authoritativeScanRunId: uuid("authoritative_scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    shadowRunId: uuid("shadow_run_id").notNull(),
    shadowRunAttemptId: uuid("shadow_run_attempt_id")
      .references(() => pmxtShadowRunAttempts.id, { onDelete: "cascade" })
      .notNull(),
    opportunityId: text("opportunity_id").notNull(),
    candidatePairId: text("candidate_pair_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("pmxt_shadow_opportunities_scan_idx").on(table.authoritativeScanRunId),
    index("pmxt_shadow_opportunities_shadow_run_idx").on(table.shadowRunId),
    index("pmxt_shadow_opportunities_attempt_idx").on(table.shadowRunAttemptId),
    uniqueIndex("pmxt_shadow_opportunities_scan_run_opp_unique").on(
      table.authoritativeScanRunId,
      table.shadowRunId,
      table.shadowRunAttemptId,
      table.opportunityId
    )
  ]
);

export const pmxtShadowComparisons = pgTable(
  "pmxt_shadow_comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authoritativeScanRunId: uuid("authoritative_scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    shadowRunId: uuid("shadow_run_id").notNull(),
    shadowRunAttemptId: uuid("shadow_run_attempt_id")
      .references(() => pmxtShadowRunAttempts.id, { onDelete: "cascade" })
      .notNull(),
    stage: text("stage").notNull(),
    outcome: text("outcome").notNull(),
    cause: text("cause").notNull(),
    authoritative: jsonb("authoritative").notNull(),
    shadow: jsonb("shadow").notNull(),
    provenance: jsonb("provenance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("pmxt_shadow_comparisons_scan_idx").on(table.authoritativeScanRunId),
    index("pmxt_shadow_comparisons_shadow_run_idx").on(table.shadowRunId),
    index("pmxt_shadow_comparisons_attempt_idx").on(table.shadowRunAttemptId),
    index("pmxt_shadow_comparisons_stage_idx").on(table.stage),
    index("pmxt_shadow_comparisons_outcome_idx").on(table.outcome),
    uniqueIndex("pmxt_shadow_comparisons_scan_run_stage_unique").on(
      table.authoritativeScanRunId,
      table.shadowRunId,
      table.shadowRunAttemptId,
      table.stage
    )
  ]
);

export const pmxtShadowTrackRuns = pgTable(
  "pmxt_shadow_track_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authoritativeScanRunId: uuid("authoritative_scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    shadowRunId: uuid("shadow_run_id").notNull(),
    shadowRunAttemptId: uuid("shadow_run_attempt_id")
      .references(() => pmxtShadowRunAttempts.id, { onDelete: "cascade" })
      .notNull(),
    track: text("track").notNull(),
    status: text("status").notNull(),
    cause: text("cause").notNull(),
    scope: jsonb("scope").notNull().default({}),
    authoritativeReceiptAt: timestamp("authoritative_receipt_at", { withTimezone: true }),
    pmxtReceiptAt: timestamp("pmxt_receipt_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("pmxt_shadow_track_runs_attempt_idx").on(table.shadowRunAttemptId),
    uniqueIndex("pmxt_shadow_track_runs_attempt_track_unique").on(table.shadowRunAttemptId, table.track)
  ]
);

export const pmxtShadowMarkets = pgTable(
  "pmxt_shadow_markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowTrackRunId: uuid("shadow_track_run_id")
      .references(() => pmxtShadowTrackRuns.id, { onDelete: "cascade" })
      .notNull(),
    catalogMarketId: text("catalog_market_id").notNull(),
    venue: text("venue"),
    venueNativeId: text("venue_native_id"),
    eligible: boolean("eligible").notNull(),
    exclusionReason: text("exclusion_reason"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull()
  },
  (table) => [
    index("pmxt_shadow_markets_track_run_idx").on(table.shadowTrackRunId),
    uniqueIndex("pmxt_shadow_markets_track_catalog_unique").on(table.shadowTrackRunId, table.catalogMarketId)
  ]
);

export const pmxtShadowRouterClusters = pgTable(
  "pmxt_shadow_router_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowTrackRunId: uuid("shadow_track_run_id")
      .references(() => pmxtShadowTrackRuns.id, { onDelete: "cascade" })
      .notNull(),
    clusterId: text("cluster_id").notNull(),
    payload: jsonb("payload").notNull()
  },
  (table) => [
    index("pmxt_shadow_router_clusters_track_run_idx").on(table.shadowTrackRunId),
    uniqueIndex("pmxt_shadow_router_clusters_track_cluster_unique").on(table.shadowTrackRunId, table.clusterId)
  ]
);

export const pmxtShadowRouterEdges = pgTable(
  "pmxt_shadow_router_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shadowTrackRunId: uuid("shadow_track_run_id")
      .references(() => pmxtShadowTrackRuns.id, { onDelete: "cascade" })
      .notNull(),
    clusterId: text("cluster_id").notNull(),
    edgeOrdinal: integer("edge_ordinal").notNull(),
    marketAId: text("market_a_id").notNull(),
    marketBId: text("market_b_id").notNull(),
    relation: text("relation").notNull(),
    confidence: numeric("confidence").notNull(),
    eligible: boolean("eligible").notNull(),
    exclusionReason: text("exclusion_reason"),
    kalshiNativeId: text("kalshi_native_id"),
    polymarketNativeId: text("polymarket_native_id"),
    payload: jsonb("payload").notNull()
  },
  (table) => [
    index("pmxt_shadow_router_edges_track_run_idx").on(table.shadowTrackRunId),
    uniqueIndex("pmxt_shadow_router_edges_track_ordinal_unique").on(
      table.shadowTrackRunId,
      table.clusterId,
      table.edgeOrdinal
    )
  ]
);
