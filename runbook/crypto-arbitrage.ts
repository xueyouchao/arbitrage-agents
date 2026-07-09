#!/usr/bin/env ts-node
/**
 * Crypto cross-venue arbitrage scanner.
 *
 * Usage:
 *   npx ts-node runbook/crypto-arbitrage.ts
 *   npx ts-node runbook/crypto-arbitrage.ts --json
 *   npx ts-node runbook/crypto-arbitrage.ts --kalshi-series KXETHD --min-edge 0.01
 *   npx ts-node runbook/crypto-arbitrage.ts --base-token FcT8... --table-id tbl...
 *
 * Scans Kalshi crypto price-level series (KXBTCD / KXETHD by default) and
 * Polymarket crypto markets, finds cross-venue arbitrage opportunities, and
 * prints results with paper-trade simulations. Does NOT require a database
 * connection — runs purely against the live venue APIs.
 *
 * When --base-token and --table-id are provided, positive-edge class-A
 * opportunities are also pushed to a Feishu Base table.
 *
 * Options:
 *   --json            Print results as JSON instead of a table
 *   --min-edge <n>    Minimum net edge (decimal, e.g. 0.02 = 2%). Default: 0
 *   --notional <n>    Override paper-trade target notionals (comma-sep). Default: 5,25,100
 *   --fee-rate <n>    Fee rate for both venues (default: 0.01)
 *   --kalshi-fee-rate <n>  Kalshi-specific fee rate (overrides --fee-rate)
 *   --poly-fee-rate <n>    Polymarket-specific fee rate (overrides --fee-rate)
 *   --no-filter       Include opportunities with zero or negative edge
 *   --kalshi-series <ticker>  Kalshi series ticker (default: KXBTCD)
 *   --poly-event-slug <slug>  Polymarket event slug (default: none, uses top-100)
 *   --poly-market-ids <ids>   Comma-separated Polymarket market condition IDs to fetch directly
 *   --base-token <token>      Feishu Base token for exporting opportunities
 *   --table-id <id>           Feishu Base table ID for exporting opportunities
 *   --as <user|bot>           Lark identity for Base export (default: user)
 *   --dry-run                 Print Base payload without writing
 *   --help                    Show usage
 */

import { config } from "dotenv";
import { spawn } from "child_process";
import { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import { PaperTradeSimulator } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { CandidatePair } from "../src/contexts/matching/domain/candidate-pair";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { ScanResult } from "../src/contexts/scanner/scanner-result";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";

config({ quiet: true });

interface CliOptions {
  json: boolean;
  noFilter: boolean;
  dryRun: boolean;
  kalshiSeries: string;
  polyEventSlug: string | undefined;
  polyMarketIds: string[];
  minEdge: number;
  notionals: number[];
  feeRate: number;
  kalshiFeeRate: number;
  polyFeeRate: number;
  baseToken: string | undefined;
  tableId: string | undefined;
  as: "user" | "bot";
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    noFilter: false,
    dryRun: false,
    kalshiSeries: "KXBTCD",
    polyEventSlug: undefined,
    polyMarketIds: [],
    minEdge: 0,
    notionals: [5, 25, 100],
    feeRate: 0.01,
    kalshiFeeRate: 0.01,
    polyFeeRate: 0.01,
    baseToken: undefined,
    tableId: undefined,
    as: "user",
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
      case "--no-filter":
        opts.noFilter = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--kalshi-series": {
        opts.kalshiSeries = consumeValue(++i, "kalshi-series");
        break;
      }
      case "--poly-event-slug": {
        opts.polyEventSlug = consumeValue(++i, "poly-event-slug");
        break;
      }
      case "--poly-market-ids": {
        const raw = consumeValue(++i, "poly-market-ids");
        opts.polyMarketIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
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
      case "--base-token": {
        opts.baseToken = consumeValue(++i, "base-token");
        break;
      }
      case "--table-id": {
        opts.tableId = consumeValue(++i, "table-id");
        break;
      }
      case "--as": {
        const raw = consumeValue(++i, "as");
        if (raw !== "user" && raw !== "bot") {
          console.error(`Error: --as must be "user" or "bot", got "${raw}".`);
          process.exit(1);
        }
        opts.as = raw;
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
  if ((opts.baseToken && !opts.tableId) || (!opts.baseToken && opts.tableId)) {
    console.error("Error: --base-token and --table-id must be provided together.");
    process.exit(1);
  }

  return opts;
}

function printUsage(): void {
  console.log("Usage: npx ts-node runbook/crypto-arbitrage.ts [options]");
  console.log("");
  console.log("Scan Kalshi + Polymarket for crypto cross-venue arbitrage.");
  console.log("");
  console.log("Options:");
  console.log("  --json             Output as JSON");
  console.log("  --min-edge <n>     Minimum net edge to report (default: 0)");
  console.log("  --notional <n>     Comma-separated paper-trade notionals (default: 5,25,100)");
  console.log("  --fee-rate <n>     Fee rate for both venues (default: 0.01)");
  console.log("  --kalshi-fee-rate <n>  Kalshi-specific fee rate (overrides --fee-rate)");
  console.log("  --poly-fee-rate <n>    Polymarket-specific fee rate (overrides --fee-rate)");
  console.log("  --no-filter        Include opportunities with zero or negative edge");
  console.log("  --kalshi-series <ticker>  Kalshi series ticker (default: KXBTCD)");
  console.log("  --poly-event-slug <slug>  Polymarket event slug (default: none)");
  console.log("  --poly-market-ids <ids>   Comma-separated Polymarket condition IDs");
  console.log("  --base-token <token>      Feishu Base token for export");
  console.log("  --table-id <id>           Feishu Base table ID for export");
  console.log("  --as <user|bot>           Lark identity for export (default: user)");
  console.log("  --dry-run                 Print Base payload without writing");
  console.log("  --help                    Show this help");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.error("🪙 Crypto Cross-Venue Arbitrage Scanner");
  console.error("─".repeat(50));

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

  const KALSHI_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";
  const POLY_BASE_URL = "https://gamma-api.polymarket.com";
  const POLY_CLOB_BASE_URL = "https://clob.polymarket.com";

  const kalshiClient = new KalshiPublicVenueClient(KALSHI_BASE_URL, {
    concurrency: envInt("KALSHI_CONCURRENCY", 5),
    retries: envInt("KALSHI_RETRIES", 3),
    timeoutMs: envInt("KALSHI_TIMEOUT_MS", 15000),
    seriesTicker: opts.kalshiSeries,
  });

  const polymarketClient = new PolymarketPublicVenueClient(POLY_BASE_URL, POLY_CLOB_BASE_URL, {
    concurrency: envInt("POLY_CONCURRENCY", 8),
    retries: envInt("POLY_RETRIES", 3),
    timeoutMs: envInt("POLY_TIMEOUT_MS", 15000),
    eventSlug: opts.polyEventSlug,
  });

  const repository = new InMemoryScannerRepository();
  const paperTradeSimulator = new PaperTradeSimulator();

  const scanner = new ReadOnlyScanner({
    kalshiClient,
    polymarketClient,
    repository,
    paperTradeSimulator,
  });

  const result = await scanner.runOnce();

  if (result.status === "failed") {
    console.error("Scan failed:", result.metrics.failureReason ?? "unknown");
    process.exit(1);
  }

  const opportunities = repository.opportunities.map((o) => o.opportunity);
  const pairById = new Map<string, CandidatePair>();
  for (const reviewed of repository.candidatePairs) {
    pairById.set(reviewed.pair.id, reviewed.pair);
  }

  if (opts.json) {
    console.log(JSON.stringify(resultToJson(result, opportunities, pairById), null, 2));
  } else {
    renderTable(result, opportunities, pairById);
  }

  if (opts.baseToken && opts.tableId) {
    if (opportunities.length === 0) {
      console.error("No class-A opportunities to export to Base.");
      return;
    }
    await exportToBase(opportunities, pairById, opts);
  }
}

function resultToJson(
  result: ScanResult,
  opportunities: CrossVenueOpportunity[],
  pairById: Map<string, CandidatePair>
): Record<string, unknown> {
  return {
    scannedAt: result.startedAt,
    summary: {
      totalMarkets: result.metrics.marketsScanned,
      normalizedMarkets: result.metrics.normalizedMarkets,
      candidatePairs: result.metrics.candidatePairs,
      opportunitiesFound: opportunities.length,
    },
    opportunities: opportunities.map((opp) => ({
      id: opp.id,
      pairId: opp.pairId,
      asset: assetForOpportunity(opp, pairById),
      direction: directionLabel(opp),
      grossEdge: opp.grossEdge,
      netEdge: opp.netEdge,
      maxTradableUsd: opp.maxTradableUsd,
      executableSizeUsd: opp.executableSizeUsd,
      equivalenceClass: opp.equivalenceClass,
      risks: risksText(opp),
      longLeg: { venue: opp.longLeg.venue, marketId: opp.longLeg.marketId, side: opp.longLeg.side },
      hedgeLeg: { venue: opp.hedgeLeg.venue, marketId: opp.hedgeLeg.marketId, side: opp.hedgeLeg.side },
    })),
  };
}

function renderTable(
  result: ScanResult,
  opportunities: CrossVenueOpportunity[],
  pairById: Map<string, CandidatePair>
): void {
  console.error("");
  console.error("📊 Scan Summary");
  console.error(`  Venues:            Kalshi + Polymarket`);
  console.error(`  Markets scanned:   ${result.metrics.marketsScanned}`);
  console.error(`  Normalized:        ${result.metrics.normalizedMarkets}`);
  console.error(`  Candidate pairs:   ${result.metrics.candidatePairs}`);
  console.error(`  Class-A opportunities: ${opportunities.length}`);
  console.error("");

  if (opportunities.length === 0) {
    console.log("⚠️  No class-A cross-venue arbitrage opportunities found.");
    console.log("   This usually means:");
    console.log("   - Polymarket has no live crypto price-level markets matching Kalshi's series");
    console.log("   - Prices are too close for a positive edge after fees");
    console.log("   - Try --no-filter to see zero/negative-edge pairs");
    return;
  }

  console.log("🪙 CRYPTO — CROSS-VENUE ARBITRAGE OPPORTUNITIES");
  console.log("═".repeat(110));

  const sorted = [...opportunities].sort((a, b) => b.netEdge - a.netEdge);
  for (const opp of sorted) {
    const asset = assetForOpportunity(opp, pairById);
    console.log(
      padRight(asset ?? "?", 8) +
      padRight(directionLabel(opp), 22) +
      padRight((opp.grossEdge * 100).toFixed(2) + "%", 9) +
      padRight((opp.netEdge * 100).toFixed(2) + "%", 9) +
      padRight("$" + opp.maxTradableUsd.toFixed(2), 12) +
      padRight("$" + opp.executableSizeUsd.toFixed(2), 12) +
      padRight(opp.longLeg.marketId.slice(0, 18), 20) +
      padRight(opp.hedgeLeg.marketId.slice(0, 18), 20)
    );
  }
  console.log("─".repeat(110));
}

function directionLabel(opp: CrossVenueOpportunity): string {
  return opp.longLeg.venue === "kalshi"
    ? "Kalshi YES / Poly NO"
    : "Poly YES / Kalshi NO";
}

function assetForOpportunity(opp: CrossVenueOpportunity, pairById: Map<string, CandidatePair>): string | undefined {
  const pair = pairById.get(opp.pairId);
  return pair?.kalshiMarket.asset ?? pair?.polymarketMarket.asset;
}

function risksText(opp: CrossVenueOpportunity): string {
  return `res:${opp.resolutionRisk}/fill:${opp.fillRisk}/liq:${opp.liquidityRisk}/venue:${opp.venueRisk}/equiv:${opp.equivalenceRisk}`;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width) + " ";
  return text.padEnd(width + 1);
}

async function exportToBase(
  opportunities: CrossVenueOpportunity[],
  pairById: Map<string, CandidatePair>,
  opts: Pick<CliOptions, "baseToken" | "tableId" | "as" | "dryRun">
): Promise<void> {
  const fields = [
    "detectedAt",
    "asset",
    "longVenue",
    "hedgeVenue",
    "direction",
    "grossEdge",
    "netEdge",
    "maxTradableUsd",
    "executableSizeUsd",
    "equivalenceClass",
    "risks",
    "status",
    "notes",
  ];

  const rows = opportunities.map((opp) => {
    const pair = pairById.get(opp.pairId);
    const asset = assetForOpportunity(opp, pairById) ?? "unknown";
    const longTitle = pair?.kalshiMarket.title ?? opp.longLeg.marketId;
    const hedgeTitle = pair?.polymarketMarket.title ?? opp.hedgeLeg.marketId;
    return [
      opp.detectedAt,
      asset,
      opp.longLeg.venue,
      opp.hedgeLeg.venue,
      directionLabel(opp),
      opp.grossEdge,
      opp.netEdge,
      opp.maxTradableUsd,
      opp.executableSizeUsd,
      opp.equivalenceClass,
      risksText(opp),
      "New",
      `Kalshi: ${longTitle} (${opp.longLeg.marketId}) | Poly: ${hedgeTitle} (${opp.hedgeLeg.marketId})`,
    ];
  });

  const payload = JSON.stringify({ fields, rows });

  if (opts.dryRun) {
    console.error("[dry-run] Base export payload:");
    console.log(payload);
    return;
  }

  console.error(`Exporting ${rows.length} opportunity(s) to Feishu Base...`);
  const larkPath = process.env.LARK_CLI_PATH ?? "lark-cli";
  const args = [
    "base", "+record-batch-create",
    "--as", opts.as,
    "--base-token", opts.baseToken!,
    "--table-id", opts.tableId!,
    "--json", payload,
  ];

  await runCommand(larkPath, args);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`lark-cli exited with ${code}: ${stderr || stdout}`));
        return;
      }
      console.log(stdout.trim());
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Fatal error:", message);
  process.exit(1);
});
