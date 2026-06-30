#!/usr/bin/env ts-node
/**
 * Emergency World Cup 2026 cross-venue arbitrage scanner.
 *
 * Usage:
 *   npx ts-node runbook/worldcup-arbitrage.ts
 *   npx ts-node runbook/worldcup-arbitrage.ts --json
 *   npx ts-node runbook/worldcup-arbitrage.ts --min-edge 0.02 --notional 50
 *
 * Scans Kalshi and Polymarket for 2026 FIFA World Cup markets, finds
 * cross-venue arbitrage opportunities, and prints results with paper-trade
 * simulations. Does NOT require a database connection — runs purely against
 * the live venue APIs.
 *
 * Options:
 *   --json            Print results as JSON instead of a table
 *   --min-edge <n>    Minimum net edge (decimal, e.g. 0.02 = 2%). Default: 0
 *   --notional <n>    Override paper-trade target notionals (comma-sep). Default: 5,25,100
 *   --fee-rate <n>    Fee rate for both venues (default: 0.01)
 *   --kalshi-fee-rate <n>  Kalshi-specific fee rate (overrides --fee-rate)
 *   --poly-fee-rate <n>   Polymarket-specific fee rate (overrides --fee-rate)
 *   --no-filter       Include opportunities with zero or negative edge
 *   --pmxt            Use pmxt unified data source (fifwc + KXWC events)
 *
 * Environment variables (venue client tuning):
 *   KALSHI_CONCURRENCY     Concurrency for Kalshi API calls (default: 5)
 *   KALSHI_RETRIES         Max retries for Kalshi API calls (default: 3)
 *   KALSHI_TIMEOUT_MS      Per-attempt timeout for Kalshi API (default: 15000)
 *   POLY_CONCURRENCY       Concurrency for Polymarket API calls (default: 8)
 *   POLY_RETRIES           Max retries for Polymarket API calls (default: 3)
 *   POLY_TIMEOUT_MS        Per-attempt timeout for Polymarket API (default: 15000)
 *   PMXT_TIMEOUT_MS        Subprocess timeout for pmxt fetch (default: 60000)
 */

import { config } from "dotenv";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
import { WorldCupArbFinder, WorldCupArbOpportunity, WorldCupArbResult } from "../src/contexts/worldcup/application/worldcup-arb-finder";
import { PmxtFetcher } from "../src/contexts/venues/infrastructure/pmxt-fetcher";
import { PmxtWcArbScanner } from "../src/contexts/worldcup/application/pmxtwc-arb-scanner";

config();

interface CliOptions {
  json: boolean;
  noFilter: boolean;
  pmxt: boolean;
  minEdge: number;
  notionals: number[];
  feeRate: number;
  kalshiFeeRate: number;
  polyFeeRate: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    noFilter: false,
    pmxt: false,
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
      case "--no-filter":
        opts.noFilter = true;
        break;
      case "--pmxt":
        opts.pmxt = true;
        break;
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

function printUsage(): void {
  console.log("Usage: npx ts-node runbook/worldcup-arbitrage.ts [options]");
  console.log("");
  console.log("Scan Kalshi + Polymarket for World Cup 2026 cross-venue arbitrage.");
  console.log("");
  console.log("Options:");
  console.log("  --json             Output as JSON");
  console.log("  --min-edge <n>     Minimum net edge to report (default: 0)");
  console.log("  --notional <n>     Comma-separated paper-trade notionals (default: 5,25,100)");
  console.log("  --fee-rate <n>     Fee rate for both venues (default: 0.01)");
  console.log("  --kalshi-fee-rate <n>  Kalshi-specific fee rate (overrides --fee-rate)");
  console.log("  --poly-fee-rate <n>   Polymarket-specific fee rate (overrides --fee-rate)");
  console.log("  --no-filter        Include opportunities with zero or negative edge");
  console.log("  --pmxt             Use pmxt unified data source (fifwc + KXWC)");
  console.log("  --help             Show this help");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.error("⚽ World Cup 2026 Cross-Venue Arbitrage Scanner");
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

  let result: WorldCupArbResult;
  if (opts.pmxt) {
    console.error("Using pmxt unified data source...");
    const fetcher = new PmxtFetcher({ timeoutMs: envInt("PMXT_TIMEOUT_MS", 60_000) });
    const scanner = new PmxtWcArbScanner(fetcher);
    result = await scanner.find({
      minNetEdge: opts.minEdge,
      noFilter: opts.noFilter,
      feeRate: opts.feeRate,
      kalshiFeeRate: opts.kalshiFeeRate,
      polyFeeRate: opts.polyFeeRate,
      paperTradeNotionals: opts.notionals,
    });
  } else {
    const kalshiClient = new KalshiPublicVenueClient(KALSHI_BASE_URL, {
      concurrency: envInt("KALSHI_CONCURRENCY", 5),
      retries: envInt("KALSHI_RETRIES", 3),
      timeoutMs: envInt("KALSHI_TIMEOUT_MS", 15000),
      expandSubMarkets: true,
    });
    const polymarketClient = new PolymarketPublicVenueClient(POLY_BASE_URL, POLY_CLOB_BASE_URL, {
      concurrency: envInt("POLY_CONCURRENCY", 8),
      retries: envInt("POLY_RETRIES", 3),
      timeoutMs: envInt("POLY_TIMEOUT_MS", 15000),
    });

    const finder = new WorldCupArbFinder({
      kalshiClient,
      polymarketClient,
    });
    result = await finder.find({
      minNetEdge: opts.minEdge,
      noFilter: opts.noFilter,
      feeRate: opts.feeRate,
      kalshiFeeRate: opts.kalshiFeeRate,
      polyFeeRate: opts.polyFeeRate,
      paperTradeNotionals: opts.notionals,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify(resultToJson(result), null, 2));
    return;
  }

  renderTable(result);
}

function resultToJson(result: WorldCupArbResult): Record<string, unknown> {
  return {
    scannedAt: result.scannedAt,
    summary: {
      totalMarkets: result.kalshiMarketCount + result.polymarketMarketCount,
      kalshiMarkets: result.kalshiMarketCount,
      polymarketMarkets: result.polymarketMarketCount,
      wcCandidatePairs: result.candidatePairs,
      opportunitiesFound: result.opportunities.length,
    },
    timings: result.timings,
    opportunities: result.opportunities.map((opp) => ({
      id: opp.opportunity.id,
      team: opp.pair.kalshiMarket.teamCode?.toUpperCase() ?? opp.pair.polymarketMarket.teamCode?.toUpperCase() ?? "?",
      marketType: opp.pair.kalshiMarket.marketType ?? opp.pair.polymarketMarket.marketType ?? "?",
      opponent: opp.pair.kalshiMarket.opponentCode?.toUpperCase() ?? opp.pair.polymarketMarket.opponentCode?.toUpperCase() ?? null,
      kalshiTitle: opp.pair.kalshiMarket.originalTitle,
      polymarketTitle: opp.pair.polymarketMarket.originalTitle,
      direction: opp.opportunity.longLeg.venue === "kalshi" ? "kalshi_yes/poly_no" : "poly_yes/kalshi_no",
      grossEdge: opp.opportunity.grossEdge,
      netEdge: opp.opportunity.netEdge,
      maxTradableUsd: opp.opportunity.maxTradableUsd,
      executableSizeUsd: opp.opportunity.executableSizeUsd,
      paperTradeSims: opp.paperTradeSimulations.map((sim) => ({
        targetNotionalUsd: sim.targetNotionalUsd,
        netEdge: sim.netEdge,
        grossEdge: sim.grossEdge,
        partialFill: sim.partialFill,
        residualUsd: sim.residualExposureUsd,
      })),
    })),
  };
}

function renderTable(result: WorldCupArbResult): void {
  console.error("");
  console.error("📊 Scan Summary");
  console.error(`  Venues:            Kalshi (${result.kalshiMarketCount} markets) + Polymarket (${result.polymarketMarketCount} markets)`);
  console.error(`  WC2026 candidates: ${result.candidatePairs} pairs`);
  console.error(`  Opportunities:     ${result.opportunities.length} with positive edge`);
  console.error(`  Total scan time:   ${result.timings.totalMs}ms`);
  console.error(`    fetch markets:   ${result.timings.fetchMarketsMs}ms`);
  console.error(`    filter + pair:   ${result.timings.filterAndPairMs}ms`);
  console.error(`    fetch books:     ${result.timings.fetchOrderbooksMs}ms`);
  console.error(`    calculate:       ${result.timings.calculateMs}ms`);
  console.error("");

  if (result.opportunities.length === 0) {
    console.log("⚠️  No cross-venue arbitrage opportunities found.");
    console.log("   This could mean:");
    console.log("   - No WC2026 winner markets listed on both venues");
    console.log("   - Prices too close for a profitable edge after fees");
    console.log("   - Venue API returned no data");
    return;
  }

  console.log("🏆 WORLD CUP 2026 — CROSS-VENUE ARBITRAGE OPPORTUNITIES");
  console.log("═".repeat(100));

  for (const opp of result.opportunities) {
    renderOpportunity(opp);
    console.log("─".repeat(100));
  }

  // Summary table of all opportunities for quick scan.
  console.log("");
  console.log("📋 SUMMARY TABLE");
  console.log("─".repeat(100));
  console.log(
    padRight("Team", 6) +
    padRight("Type", 10) +
    padRight("Dir", 18) +
    padRight("Gross%", 8) +
    padRight("Net%", 8) +
    padRight("Max$", 10) +
    padRight("Best Sim", 12) +
    padRight("Kalshi Title", 40) +
    "... Polymarket Title"
  );
  console.log("─".repeat(100));

  const sorted = [...result.opportunities].sort((a, b) => b.opportunity.netEdge - a.opportunity.netEdge);
  for (const opp of sorted) {
    const direction = opp.opportunity.longLeg.venue === "kalshi" ? "Kal↑ Poly↓" : "Poly↑ Kal↓";
    const bestSim = opp.paperTradeSimulations.reduce<WorldCupArbOpportunity["paperTradeSimulations"][0] | null>(
      (best, sim) => !best || sim.netEdge > best.netEdge ? sim : best,
      null
    );
    const bestEdge = bestSim ? (bestSim.netEdge * 100).toFixed(2) + "%" : "-";
    console.log(
      padRight(opp.pair.kalshiMarket.teamCode?.toUpperCase() ?? opp.pair.polymarketMarket.teamCode?.toUpperCase() ?? "?", 6) +
      padRight(opp.pair.kalshiMarket.marketType ?? opp.pair.polymarketMarket.marketType ?? "?", 10) +
      padRight(direction, 18) +
      padRight((opp.opportunity.grossEdge * 100).toFixed(2) + "%", 8) +
      padRight((opp.opportunity.netEdge * 100).toFixed(2) + "%", 8) +
      padRight("$" + opp.opportunity.maxTradableUsd.toFixed(2), 10) +
      padRight(bestEdge, 12) +
      padRight(truncate(opp.pair.kalshiMarket.originalTitle ?? "", 38), 40) +
      truncate(opp.pair.polymarketMarket.originalTitle ?? "", 30)
    );
  }
  console.log("─".repeat(100));
}

function renderOpportunity(opp: WorldCupArbOpportunity): void {
  const kalshi = opp.pair.kalshiMarket;
  const poly = opp.pair.polymarketMarket;
  const direction = opp.opportunity.longLeg.venue === "kalshi"
    ? "LONG Kalshi YES  +  LONG Polymarket NO"
    : "LONG Polymarket YES  +  LONG Kalshi NO";

  console.log("");
  console.log(`  🎯 Team: ${kalshi.teamCode?.toUpperCase() ?? poly.teamCode?.toUpperCase() ?? "?"}`);
  console.log(`  📂 Type: ${kalshi.marketType ?? poly.marketType ?? "?"}`);
  console.log(`  🔄 Direction: ${direction}`);
  console.log(`  💰 Gross Edge: ${(opp.opportunity.grossEdge * 100).toFixed(2)}%`);
  console.log(`  💸 Net Edge:   ${(opp.opportunity.netEdge * 100).toFixed(2)}%`);
  console.log(`  📦 Max Tradable: $${opp.opportunity.maxTradableUsd.toFixed(2)}`);
  console.log(`  ✅ Executable Size: $${opp.opportunity.executableSizeUsd.toFixed(2)}`);
  console.log(`  🏷️  Kalshi:      ${kalshi.originalTitle ?? "?"}`);
  console.log(`  🏷️  Polymarket:  ${poly.originalTitle ?? "?"}`);
  console.log(`  📅 Risks: resolution=${opp.opportunity.resolutionRisk} fill=${opp.opportunity.fillRisk} liquidity=${opp.opportunity.liquidityRisk}`);

  console.log("");
  console.log("  Paper Trade Simulations:");
  console.log("  " + "─".repeat(70));
  console.log(
    "  " +
    padRight("Notional", 10) +
    padRight("Gross%", 8) +
    padRight("Net%", 8) +
    padRight("Fees", 8) +
    padRight("Slip", 8) +
    padRight("Partial?", 8) +
    padRight("Residual$", 10)
  );
  console.log("  " + "─".repeat(70));

  for (const sim of opp.paperTradeSimulations) {
    console.log(
      "  " +
      padRight("$" + sim.targetNotionalUsd.toFixed(0), 10) +
      padRight((sim.grossEdge * 100).toFixed(2) + "%", 8) +
      padRight((sim.netEdge * 100).toFixed(2) + "%", 8) +
      padRight("$" + (sim.longLegFill.fees + sim.hedgeLegFill.fees).toFixed(4), 8) +
      padRight("$" + (sim.longLegFill.slippage + sim.hedgeLegFill.slippage).toFixed(4), 8) +
      padRight(sim.partialFill ? "YES ⚠️" : "no", 8) +
      padRight("$" + sim.residualExposureUsd.toFixed(2), 10)
    );
  }
  console.log("  " + "─".repeat(70));
}

function padRight(text: string, width: number): string {
  // Returns width+1 characters: the text padded/truncated to `width`
  // plus a trailing space as the column separator.
  if (text.length >= width) return text.slice(0, width) + " ";
  return text.padEnd(width + 1);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Fatal error:", message);
  process.exit(1);
});
