/**
 * Application service that uses pmxt as a unified data source to find
 * World Cup 2026 cross-venue arbitrage opportunities.
 *
 * Architecture (DDD):
 *   Infrastructure → PmxtFetcher (calls pmxt Python script)
 *   Application  → PmxtWcArbScanner (this file)
 *   Domain       → normalizer, pair-matcher, equivalence-policy,
 *                  opportunity-calculator, paper-trade-simulator
 *
 * No domain types are modified — the scanner reuses every existing
 * domain service unchanged.
 */

import { OpportunityCalculator } from "../../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../../arbitrage/domain/opportunity";
import { PaperTradeSimulation, PaperTradeSimulator } from "../../arbitrage/domain/paper-trade-simulator";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { PmxtFetcher } from "../../venues/infrastructure/pmxt-fetcher";
import { WorldCupCandidatePair, buildWorldCupPairs } from "../domain/worldcup-pair-matcher";
import { classifyWorldCupPair } from "../domain/worldcup-equivalence-policy";

// Re-export the same result types used by WorldCupArbFinder so callers
// (e.g. the runbook) can treat both scanners interchangeably.
export type { WorldCupArbOpportunity, WorldCupArbResult, WorldCupArbTimings } from "./worldcup-arb-finder";
import type { WorldCupArbOpportunity, WorldCupArbResult, WorldCupArbTimings } from "./worldcup-arb-finder";

export interface PmxtWcArbScannerOptions {
  /** Wall-clock for the OpportunityCalculator. Defaults to `new Date().toISOString()`. */
  scanTimeUtc?: string;
  /** Flat fee-rate for both venues. Default: 0.01. */
  feeRate?: number;
  /** Kalshi-specific fee rate. Default: feeRate. */
  kalshiFeeRate?: number;
  /** Polymarket-specific fee rate. Default: feeRate. */
  polyFeeRate?: number;
  /** Minimum net edge. Default: 0. */
  minNetEdge?: number;
  /** When true, skip edge filtering. Default: false. */
  noFilter?: boolean;
  /** Target notionals for paper-trade sim. Default: [5, 25, 100]. */
  paperTradeNotionals?: number[];
  /** Adverse selection bps. Default: 25. */
  paperTradeAdverseSelectionBps?: number;
  /** Timeout for the pmxt subprocess in ms. Default: 30_000. */
  pmxtTimeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<PmxtWcArbScannerOptions> = {
  scanTimeUtc: "",
  feeRate: 0.01,
  kalshiFeeRate: 0.01,
  polyFeeRate: 0.01,
  minNetEdge: 0,
  noFilter: false,
  paperTradeNotionals: [5, 25, 100],
  paperTradeAdverseSelectionBps: 25,
  pmxtTimeoutMs: 30_000,
};

/**
 * Application service that scans both Polymarket and Kalshi for
 * World Cup 2026 match-level arbitrage opportunities, using pmxt
 * as the unified data source.
 */
export class PmxtWcArbScanner {
  // TODO: add unit tests (mocking PmxtFetcher subprocess call) mirroring
  // test/worldcup-finder.test.ts coverage for the pmxt scanner path.
  constructor(
    private readonly fetcher: PmxtFetcher,
    private readonly calculator?: OpportunityCalculator,
    private readonly simulator?: PaperTradeSimulator,
    private readonly clock?: () => string,
  ) {}

  async find(options: PmxtWcArbScannerOptions = {}): Promise<WorldCupArbResult> {
    const totalStart = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const calculator = this.calculator ?? new OpportunityCalculator();
    const sim = this.simulator ?? new PaperTradeSimulator();

    // Step 1: fetch markets AND orderbooks from both venues in one call.
    const fetchStart = Date.now();
    const result = await this.fetcher.fetch();
    const fetchMarketsMs = Date.now() - fetchStart;

    // Use the pmxt fetch's capturedAt as the scan timestamp so the book
    // age check (isUsableBook) uses consistent timing (the Python script's
    // capturedAt is set AFTER queries finish, which is AFTER scanTimeUtc
    // would be if we computed it before the fetch).
    const scanTimeUtc = opts.scanTimeUtc || result.capturedAt || (this.clock?.() ?? new Date().toISOString());

    const kalshiMarkets = result.kalshiMarkets;
    const polymarketMarkets = result.polymarketMarkets;
    const allMarkets = [...kalshiMarkets, ...polymarketMarkets];

    // Step 2 + 3: classify to WC2026, build candidate pairs.
    const pairStart = Date.now();
    const pairs = buildWorldCupPairs(allMarkets);
    const filterAndPairMs = Date.now() - pairStart;

    // Step 4: build book lookup (books already fetched alongside markets).
    const obStart = Date.now();
    const booksByVenueId = new Map<string, MarketBook>();
    for (const book of [...result.kalshiBooks, ...result.polymarketBooks]) {
      booksByVenueId.set(`${book.venue}:${book.marketId}`, book);
    }
    const fetchOrderbooksMs = Date.now() - obStart;

    // Step 5 + 6: calculate opportunities and run paper-trade simulations.
    const calcStart = Date.now();
    const opportunities: WorldCupArbOpportunity[] = [];

    const feeModels = {
      kalshi: { type: "flat" as const, rate: opts.kalshiFeeRate },
      polymarket: { type: "flat" as const, rate: opts.polyFeeRate },
    };

    for (const pair of pairs) {
      const decision = classifyWorldCupPair(pair);
      if (decision.equivalenceClass !== "A") continue;

      const kalshiBook = booksByVenueId.get(`kalshi:${pair.kalshiMarket.venueMarketId}`);
      const polyBook = booksByVenueId.get(`polymarket:${pair.polymarketMarket.venueMarketId}`);
      if (!kalshiBook || !polyBook) continue;

      const opps = calculator.calculate(
        pair.genericPair,
        decision,
        kalshiBook,
        polyBook,
        {
          now: scanTimeUtc,
          feeRate: opts.feeRate,
          slippageRate: 0.005,
          minNetEdge: opts.noFilter ? -Infinity : opts.minNetEdge,
          feeModels,
        },
      );

      for (const op of opps) {
        const sims = sim.simulate(op, {
          targetNotionalsUsd: opts.paperTradeNotionals,
          adverseSelectionBps: opts.paperTradeAdverseSelectionBps,
        });
        opportunities.push({ pair, opportunity: op, paperTradeSimulations: sims });
      }
    }
    const calculateMs = Date.now() - calcStart;

    // Count WC2026 markets per venue (from pair set).
    const worldCupKalshi = pairs.reduce<number>((n, p) => n + (p.kalshiMarket.venue === "kalshi" ? 1 : 0), 0);
    const worldCupPolymarket = pairs.reduce<number>((n, p) => n + (p.polymarketMarket.venue === "polymarket" ? 1 : 0), 0);

    return {
      scannedAt: scanTimeUtc,
      kalshiMarketCount: kalshiMarkets.length,
      polymarketMarketCount: polymarketMarkets.length,
      worldCupKalshi,
      worldCupPolymarket,
      candidatePairs: pairs.length,
      opportunities,
      timings: {
        fetchMarketsMs,
        filterAndPairMs,
        fetchOrderbooksMs,
        calculateMs,
        totalMs: Date.now() - totalStart,
      },
    };
  }
}