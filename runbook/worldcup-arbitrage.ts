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
 *   --fee-rate <n>    Override fee rate for both venues. Default: 0.01
 *   --no-filter       Include opportunities with zero or negative edge
 */

import { config } from "dotenv";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
import { WorldCupArbFinder, WorldCupArbOpportunity, WorldCupArbResult } from "../src/contexts/worldcup/application/worldcup-arb-finder";

config();

interface CliOptions {
  json: boolean;
  noFilter: boolean;
  minEdge: number;
  notionals: number[];
  feeRate: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    json: false,
    noFilter: false,
    minEdge: 0,
    notionals: [5, 25, 100],
    feeRate: 0.01,
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
        opts.feeRate = parseFloat(raw);
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

  // --no-filter: set minEdge to an unambiguously impossible netEdge value so no
  // opportunity gets filtered out, regardless of edge calculation details.
  if (opts.noFilter) {
    opts.minEdge = -1_000_000;
  }

  // --- post-parse validation ---
  if (!opts.noFilter && (!Number.isFinite(opts.minEdge) || opts.minEdge < 0)) {
    console.error(`Error: --min-edge must be a non-negative number, got "${opts.minEdge}".`);
    process.exit(1);
  }
  if (!Number.isFinite(opts.feeRate) || opts.feeRate <= 0 || opts.feeRate >= 1) {
    console.error(`Error: --fee-rate must be a number between 0 and 1 (exclusive), got "${opts.feeRate}".`);
    process.exit(1);
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
  console.log("  --no-filter        Include opportunities with zero or negative edge");
  console.log("  --help             Show this help");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.error("⚽ World Cup 2026 Cross-Venue Arbitrage Scanner");
  console.error("─".repeat(50));

  const kalshiClient = new KalshiPublicVenueClient(undefined, {
    concurrency: 5,
    retries: 3,
    timeoutMs: 15_000,
  });
  const polymarketClient = new PolymarketPublicVenueClient(undefined, undefined, {
    concurrency: 8,
    retries: 3,
    timeoutMs: 15_000,
  });

  const finder = new WorldCupArbFinder({
    kalshiClient,
    polymarketClient,
  });

  console.error("Scanning venues...");
  const result = await finder.find({
    minNetEdge: opts.minEdge,
    feeRate: opts.feeRate,
    paperTradeNotionals: opts.notionals,
  });

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
      team: opp.pair.kalshiMarket.teamCode?.toUpperCase() ?? "?",
      marketType: opp.pair.kalshiMarket.marketType,
      opponent: opp.pair.kalshiMarket.opponentCode?.toUpperCase() ?? null,
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
      padRight(opp.pair.kalshiMarket.teamCode?.toUpperCase() ?? "?", 6) +
      padRight(opp.pair.kalshiMarket.marketType, 10) +
      padRight(direction, 18) +
      padRight((opp.opportunity.grossEdge * 100).toFixed(2) + "%", 8) +
      padRight((opp.opportunity.netEdge * 100).toFixed(2) + "%", 8) +
      padRight("$" + opp.opportunity.maxTradableUsd.toFixed(2), 10) +
      padRight(bestEdge, 12) +
      padRight(truncate(opp.pair.kalshiMarket.originalTitle, 38), 40) +
      truncate(opp.pair.polymarketMarket.originalTitle, 30)
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
  console.log(`  🎯 Team: ${kalshi.teamCode?.toUpperCase() ?? "?"}`);
  console.log(`  📂 Type: ${kalshi.marketType}`);
  console.log(`  🔄 Direction: ${direction}`);
  console.log(`  💰 Gross Edge: ${(opp.opportunity.grossEdge * 100).toFixed(2)}%`);
  console.log(`  💸 Net Edge:   ${(opp.opportunity.netEdge * 100).toFixed(2)}%`);
  console.log(`  📦 Max Tradable: $${opp.opportunity.maxTradableUsd.toFixed(2)}`);
  console.log(`  ✅ Executable Size: $${opp.opportunity.executableSizeUsd.toFixed(2)}`);
  console.log(`  🏷️  Kalshi:      ${kalshi.originalTitle}`);
  console.log(`  🏷️  Polymarket:  ${poly.originalTitle}`);
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
  return text.padEnd(width).slice(0, width) + " ";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
