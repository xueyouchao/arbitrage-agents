#!/usr/bin/env ts-node
/**
 * Live cross-venue arbitrage monitor (Issue #75, #76).
 *
 * Runs the World Cup arbitrage scan at a configurable interval and prints
 * only opportunities whose order books pass the freshness guard in
 * OpportunityCalculator.isUsableBook() — i.e. capturedAt within
 * maxBookAgeMs (default 60s) of the scan time. Stale books produce no
 * opportunities, so they are naturally filtered out.
 *
 * Issue #76: when a verified edge is found at or above the --min-edge
 * threshold, the monitor (1) prints a console alert line with team,
 * direction, net edge %, venue prices, and max tradable USD, and (2)
 * persists an alert record to the existing `alerts` table. DB
 * persistence is best-effort and requires DATABASE_URL; the console
 * line is always emitted for qualifying edges.
 *
 * Usage:
 *   npx ts-node runbook/live-monitor.ts
 *   npx ts-node runbook/live-monitor.ts --json
 *   npx ts-node runbook/live-monitor.ts --interval 30000
 *   npx ts-node runbook/live-monitor.ts --min-edge 0.02 --max-book-age 45000
 *
 * Options:
 *   --json                  Emit one JSON object per scan on stdout (clean for piping)
 *   --interval <ms>         Polling interval in ms (default: 60000, env LIVE_MONITOR_INTERVAL_MS)
 *   --max-book-age <ms>     Max acceptable book age in ms (default: 60000, env LIVE_MONITOR_MAX_BOOK_AGE_MS)
 *   --min-edge <n>          Minimum net edge (decimal, e.g. 0.02 = 2%). Default: 0
 *   --notional <n>          Comma-separated paper-trade notionals. Default: 5,25,100
 *   --fee-rate <n>          Fee rate for both venues (default: 0.01)
 *   --kalshi-fee-rate <n>   Kalshi-specific fee rate (overrides --fee-rate)
 *   --poly-fee-rate <n>    Polymarket-specific fee rate (overrides --fee-rate)
 *   --once                  Run a single scan and exit (no loop)
 *   --help                  Show this help
 *
 * Environment variables:
 *   LIVE_MONITOR_INTERVAL_MS    Polling interval (default: 60000)
 *   LIVE_MONITOR_MAX_BOOK_AGE_MS  Freshness threshold for book age (default: 60000)
 *   KALSHI_CONCURRENCY          Concurrency for Kalshi API calls (default: 5)
 *   KALSHI_RETRIES               Max retries for Kalshi API calls (default: 3)
 *   KALSHI_TIMEOUT_MS           Per-attempt timeout for Kalshi API (default: 15000)
 *   POLY_CONCURRENCY            Concurrency for Polymarket API calls (default: 8)
 *   POLY_RETRIES                Max retries for Polymarket API calls (default: 3)
 *   POLY_TIMEOUT_MS             Per-attempt timeout for Polymarket API (default: 15000)
 */

import { config } from "dotenv";
import { Pool } from "pg";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
import { WorldCupArbFinder, WorldCupArbOpportunity, WorldCupArbResult } from "../src/contexts/worldcup/application/worldcup-arb-finder";
import { uuidFromStableKey } from "../src/contexts/shared/stable-id";

config({ quiet: true });

interface CliOptions {
  json: boolean;
  once: boolean;
  intervalMs: number;
  maxBookAgeMs: number;
  minEdge: number;
  notionals: number[];
  feeRate: number;
  kalshiFeeRate: number;
  polyFeeRate: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    once: false,
    intervalMs: envInt("LIVE_MONITOR_INTERVAL_MS", 60_000),
    maxBookAgeMs: envInt("LIVE_MONITOR_MAX_BOOK_AGE_MS", 60_000),
    minEdge: 0,
    notionals: [5, 25, 100],
    feeRate: 0.01,
    kalshiFeeRate: 0.01,
    polyFeeRate: 0.01,
  };

  function consumeValue(index: number, label: string): string {
    if (index >= argv.length) {
      console.error(`Error: --${label} requires a value.`);
      process.exit(1);
    }
    const val = argv[index];
    if (val.startsWith("--")) {
      console.error(`Error: --${label} expected a value, got "${val}".`);
      process.exit(1);
    }
    return val;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        opts.json = true;
        break;
      case "--once":
        opts.once = true;
        break;
      case "--interval": {
        const raw = consumeValue(++i, "interval");
        const v = parseInt(raw, 10);
        if (!Number.isFinite(v) || v <= 0) {
          console.error(`Error: --interval must be a positive integer (got "${raw}").`);
          process.exit(1);
        }
        opts.intervalMs = v;
        break;
      }
      case "--max-book-age": {
        const raw = consumeValue(++i, "max-book-age");
        const v = parseInt(raw, 10);
        if (!Number.isFinite(v) || v <= 0) {
          console.error(`Error: --max-book-age must be a positive integer (got "${raw}").`);
          process.exit(1);
        }
        opts.maxBookAgeMs = v;
        break;
      }
      case "--min-edge": {
        const raw = consumeValue(++i, "min-edge");
        opts.minEdge = parseFloat(raw);
        break;
      }
      case "--notional": {
        const raw = consumeValue(++i, "notional");
        const tokens = raw.split(",").map((s) => s.trim());
        const filtered = tokens.filter((s) => {
          const n = parseFloat(s);
          return Number.isFinite(n) && n > 0;
        }).map((s) => parseFloat(s));
        const skipped = tokens.length - filtered.length;
        if (skipped > 0) {
          console.warn(`Warning: --notional ignored ${skipped} invalid value(s) (must be positive numbers).`);
        }
        opts.notionals = filtered;
        break;
      }
      case "--fee-rate": {
        const raw = consumeValue(++i, "fee-rate");
        const v = parseFloat(raw);
        opts.feeRate = v;
        opts.kalshiFeeRate = v;
        opts.polyFeeRate = v;
        break;
      }
      case "--kalshi-fee-rate": {
        const raw = consumeValue(++i, "kalshi-fee-rate");
        opts.kalshiFeeRate = parseFloat(raw);
        break;
      }
      case "--poly-fee-rate": {
        const raw = consumeValue(++i, "poly-fee-rate");
        opts.polyFeeRate = parseFloat(raw);
        break;
      }
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        console.warn(`Unknown option: ${arg}. Use --help for usage.`);
    }
  }

  // --- post-parse validation ---
  if (!Number.isFinite(opts.minEdge) || opts.minEdge < 0 || opts.minEdge > 1) {
    console.error(`Error: --min-edge must be a number between 0 and 1 (got "${opts.minEdge}").`);
    process.exit(1);
  }
  if (!Number.isFinite(opts.feeRate) || opts.feeRate <= 0 || opts.feeRate >= 1) {
    console.error(`Error: --fee-rate must be a number between 0 and 1 (exclusive), got "${opts.feeRate}".`);
    process.exit(1);
  }
  for (const [label, val] of [["--kalshi-fee-rate", opts.kalshiFeeRate] as const, ["--poly-fee-rate", opts.polyFeeRate] as const]) {
    if (!Number.isFinite(val) || val <= 0 || val >= 1) {
      console.error(`Error: ${label} must be a number between 0 and 1 (exclusive), got "${val}".`);
      process.exit(1);
    }
  }
  if (opts.notionals.length === 0) {
    console.error("Error: --notional must specify at least one positive number (e.g. \"5,25,100\").");
    process.exit(1);
  }

  return opts;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Warning: ${key}="${raw}" is not a positive integer, using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function printUsage(): void {
  console.log("Usage: npx ts-node runbook/live-monitor.ts [options]");
  console.log("");
  console.log("Live cross-venue arbitrage monitor — polls at a short interval and prints");
  console.log("only opportunities that pass the freshness guard (capturedAt within maxBookAgeMs).");
  console.log("");
  console.log("Options:");
  console.log("  --json                Output one JSON object per scan on stdout");
  console.log("  --interval <ms>       Polling interval (default: 60000, env LIVE_MONITOR_INTERVAL_MS)");
  console.log("  --max-book-age <ms>   Max book age in ms (default: 60000, env LIVE_MONITOR_MAX_BOOK_AGE_MS)");
  console.log("  --min-edge <n>        Minimum net edge to report (default: 0)");
  console.log("  --notional <n>        Comma-separated paper-trade notionals (default: 5,25,100)");
  console.log("  --fee-rate <n>        Fee rate for both venues (default: 0.01)");
  console.log("  --kalshi-fee-rate <n> Kalshi-specific fee rate (overrides --fee-rate)");
  console.log("  --poly-fee-rate <n>  Polymarket-specific fee rate (overrides --fee-rate)");
  console.log("  --once                Run a single scan and exit");
  console.log("  --help                Show this help");
}

export interface VerifiedEdge {
  id: string;
  team: string;
  marketType: string;
  opponent: string | null;
  direction: string;
  grossEdge: number;
  netEdge: number;
  maxTradableUsd: number;
  executableSizeUsd: number;
  dataStalenessMs: number;
  venueRisk: string;
  kalshiTitle: string;
  polymarketTitle: string;
  // Issue #76: venue ask prices for the console alert line so an operator
  // can see the two prices that produce the edge without querying the DB.
  kalshiYesAsk: number;
  polymarketNoAsk: number;
}

export interface ScanOutput {
  scannedAt: string;
  intervalMs: number;
  maxBookAgeMs: number;
  summary: {
    kalshiMarkets: number;
    polymarketMarkets: number;
    candidatePairs: number;
    verifiedEdges: number;
    staleBooksFiltered: number;
  };
  timings: WorldCupArbResult["timings"];
  edges: VerifiedEdge[];
}

/**
 * Converts a scan result into the live-monitor output, keeping only edges
 * that passed the freshness guard. The OpportunityCalculator already rejects
 * books whose capturedAt is older than maxBookAgeMs, so any opportunity in
 * the result is verified-fresh by construction. We also double-check
 * dataStalenessMs defensively.
 *
 * Exported for unit testing (Issue #75).
 */
export function toVerifiedOutput(result: WorldCupArbResult, maxBookAgeMs: number, intervalMs: number): ScanOutput {
  const fresh = result.opportunities.filter((o) => o.opportunity.dataStalenessMs <= maxBookAgeMs);
  const staleBooksFiltered = result.opportunities.length - fresh.length;

  return {
    scannedAt: result.scannedAt,
    intervalMs,
    maxBookAgeMs,
    summary: {
      kalshiMarkets: result.kalshiMarketCount,
      polymarketMarkets: result.polymarketMarketCount,
      candidatePairs: result.candidatePairs,
      verifiedEdges: fresh.length,
      staleBooksFiltered,
    },
    timings: result.timings,
    edges: fresh.map((o) => toEdge(o)),
  };
}

function toEdge(opp: WorldCupArbOpportunity): VerifiedEdge {
  const kalshi = opp.pair.kalshiMarket;
  const poly = opp.pair.polymarketMarket;
  // Venue ask prices: the long leg is the YES ask, the hedge leg is the NO
  // ask. For "kalshi_yes/poly_no" the Kalshi YES ask and the Polymarket NO
  // ask are the two prices; for the opposite direction they swap venues.
  const kalshiYesAsk = opp.opportunity.longLeg.venue === "kalshi"
    ? opp.opportunity.longLeg.askPrice
    : opp.opportunity.hedgeLeg.askPrice;
  const polymarketNoAsk = opp.opportunity.hedgeLeg.venue === "polymarket"
    ? opp.opportunity.hedgeLeg.askPrice
    : opp.opportunity.longLeg.askPrice;
  return {
    id: opp.opportunity.id,
    team: kalshi.teamCode?.toUpperCase() ?? poly.teamCode?.toUpperCase() ?? "?",
    marketType: kalshi.marketType ?? poly.marketType ?? "?",
    opponent: kalshi.opponentCode?.toUpperCase() ?? poly.opponentCode?.toUpperCase() ?? null,
    direction: opp.opportunity.longLeg.venue === "kalshi" ? "kalshi_yes/poly_no" : "poly_yes/kalshi_no",
    grossEdge: opp.opportunity.grossEdge,
    netEdge: opp.opportunity.netEdge,
    maxTradableUsd: opp.opportunity.maxTradableUsd,
    executableSizeUsd: opp.opportunity.executableSizeUsd,
    dataStalenessMs: opp.opportunity.dataStalenessMs,
    venueRisk: opp.opportunity.venueRisk,
    kalshiTitle: kalshi.originalTitle ?? "",
    polymarketTitle: poly.originalTitle ?? "",
    kalshiYesAsk,
    polymarketNoAsk,
  };
}

/**
 * Issue #76: channel tag persisted in the `alerts` table for alerts emitted
 * by the live-monitor runbook via console + DB persistence.
 */
export const ALERT_CHANNEL_CONSOLE_DB = "console+db";

/**
 * Issue #76: a record describing one alert to persist into the `alerts`
 * table. The `opportunityId` references `opportunities.id`; the `payload`
 * carries the human-readable fields (team, direction, edge, prices) so an
 * operator can read the alert context from the row without re-joining.
 */
export interface AlertInsert {
  opportunityId: string;
  channel: string;
  payload: Record<string, unknown>;
}

export interface AlertOptions {
  /** Minimum net edge (decimal) required to emit an alert. Default: 0. */
  minEdge: number;
}

/**
 * Issue #76: decide which verified edges in a scan output warrant an alert
 * and build the alert records for DB persistence. Edges with netEdge >=
 * minEdge produce one AlertInsert each; edges below the threshold are
 * dropped. The payload carries the same fields the console line prints so
 * the persisted row is self-describing.
 *
 * Exported for unit testing. Does not touch the DB — the caller is
 * responsible for inserting the returned records.
 */
export function buildAlerts(output: ScanOutput, options: AlertOptions): AlertInsert[] {
  const minEdge = options.minEdge ?? 0;
  const qualifying = output.edges.filter((edge) => edge.netEdge >= minEdge);
  return qualifying.map((edge) => ({
    opportunityId: edge.id,
    channel: ALERT_CHANNEL_CONSOLE_DB,
    payload: {
      team: edge.team,
      marketType: edge.marketType,
      opponent: edge.opponent,
      direction: edge.direction,
      grossEdge: edge.grossEdge,
      netEdge: edge.netEdge,
      maxTradableUsd: edge.maxTradableUsd,
      executableSizeUsd: edge.executableSizeUsd,
      dataStalenessMs: edge.dataStalenessMs,
      venueRisk: edge.venueRisk,
      kalshiTitle: edge.kalshiTitle,
      polymarketTitle: edge.polymarketTitle,
      kalshiYesAsk: edge.kalshiYesAsk,
      polymarketNoAsk: edge.polymarketNoAsk,
      scannedAt: output.scannedAt,
    },
  }));
}

/**
 * Issue #76: format a single verified edge as a human-readable console
 * alert line containing team, direction, net edge %, venue prices, and
 * max tradable USD. Printed on stdout by the live-monitor runbook.
 */
export function formatAlertLine(edge: VerifiedEdge): string {
  const netEdgePct = (edge.netEdge * 100).toFixed(2);
  const maxUsd = edge.maxTradableUsd.toFixed(2);
  return `ALERT ${edge.team} ${edge.direction}  net=${netEdgePct}%  kalshi_yes=${edge.kalshiYesAsk.toFixed(4)}  poly_no=${edge.polymarketNoAsk.toFixed(4)}  max=$${maxUsd}`;
}

/**
 * Issue #76: persist alert records into the `alerts` table. Each alert
 * references its parent opportunity by the deterministic stable-id derived
 * from the opportunity key, and carries the alert payload as jsonb. The
 * `alerts` table has columns (id, opportunity_id, channel, payload,
 * emitted_at) — we let the DB default the id and emitted_at.
 *
 * Exported for unit testing via dependency injection of the query runner.
 */
export async function persistAlerts(
  alerts: AlertInsert[],
  queryFn?: (text: string, params: unknown[]) => Promise<unknown>
): Promise<void> {
  if (alerts.length === 0) return;
  const pool = queryFn ? undefined : new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const alert of alerts) {
      const opportunityUuid = uuidFromStableKey(alert.opportunityId);
      const text = `insert into alerts (opportunity_id, channel, payload) values ($1, $2, $3::jsonb)`;
      const params = [opportunityUuid, alert.channel, JSON.stringify(alert.payload)];
      if (queryFn) {
        await queryFn(text, params);
      } else if (pool) {
        await pool.query(text, params);
      }
    }
  } finally {
    if (pool) await pool.end();
  }
}

async function runScan(opts: CliOptions): Promise<void> {
  const KALSHI_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";
  const POLY_BASE_URL = "https://gamma-api.polymarket.com";
  const POLY_CLOB_BASE_URL = "https://clob.polymarket.com";

  const kalshiClient = new KalshiPublicVenueClient(KALSHI_BASE_URL, {
    concurrency: envInt("KALSHI_CONCURRENCY", 5),
    retries: envInt("KALSHI_RETRIES", 3),
    timeoutMs: envInt("KALSHI_TIMEOUT_MS", 15000),
    expandSubMarkets: true,
    eventTicker: "KXWC",
  });
  const polymarketClient = new PolymarketPublicVenueClient(POLY_BASE_URL, POLY_CLOB_BASE_URL, {
    concurrency: envInt("POLY_CONCURRENCY", 8),
    retries: envInt("POLY_RETRIES", 3),
    timeoutMs: envInt("POLY_TIMEOUT_MS", 15000),
    eventSlug: "fifwc",
  });

  const finder = new WorldCupArbFinder({ kalshiClient, polymarketClient });

  const result = await finder.find({
    minNetEdge: opts.minEdge,
    feeRate: opts.feeRate,
    kalshiFeeRate: opts.kalshiFeeRate,
    polyFeeRate: opts.polyFeeRate,
    paperTradeNotionals: opts.notionals,
  });

  const output = toVerifiedOutput(result, opts.maxBookAgeMs, opts.intervalMs);

  // Issue #76: build alert records for verified edges above the min-edge
  // threshold and emit them to the console + DB.
  const alerts = buildAlerts(output, { minEdge: opts.minEdge });

  if (opts.json) {
    // Clean JSON on stdout — one object per scan.
    console.log(JSON.stringify(output));
  } else {
    // Human-readable progress on stderr, data on stdout.
    console.error(`[${output.scannedAt}] ${output.summary.verifiedEdges} verified edge(s), ${output.summary.staleBooksFiltered} stale filtered (${result.timings.totalMs}ms)`);
    for (const edge of output.edges) {
      console.log(`${edge.team} ${edge.marketType} ${edge.direction}  net=${(edge.netEdge * 100).toFixed(2)}%  max=$${edge.maxTradableUsd.toFixed(2)}  staleness=${edge.dataStalenessMs}ms  risk=${edge.venueRisk}`);
    }
    for (const edge of output.edges.filter((e) => e.netEdge >= opts.minEdge)) {
      console.log(formatAlertLine(edge));
    }
  }

  // Issue #76: persist alerts to the `alerts` table. Best-effort — a DB
  // failure must not crash the scan loop. Only attempt when a DATABASE_URL
  // is configured (the runbook can run console-only without a DB).
  if (alerts.length > 0 && process.env.DATABASE_URL) {
    try {
      await persistAlerts(alerts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Alert persistence failed: ${message}`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.error("📡 Live Cross-Venue Arbitrage Monitor (Issue #75)");
  console.error(`   interval: ${opts.intervalMs}ms  max-book-age: ${opts.maxBookAgeMs}ms  min-edge: ${opts.minEdge}`);
  console.error("─".repeat(50));
  console.error("Press Ctrl+C to stop.\n");

  if (opts.once) {
    await runScan(opts);
    return;
  }

  // Loop until interrupted. Each iteration waits for the interval before the
  // next scan; the first scan runs immediately.
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    console.error("\n⏹  Stopping after current scan completes...");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();
    try {
      await runScan(opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Scan error: ${message}`);
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, opts.intervalMs - elapsed);
    if (wait > 0) {
      await sleep(wait);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only run main when executed directly (not when imported by tests).
if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Fatal error:", message);
    process.exit(1);
  });
}