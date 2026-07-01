/**
 * Emergency World Cup 2026 arbitrage finder.
 *
 * This is the main entry point for the emergency World Cup arbitrage
 * pipeline. It bypasses the generic scanner's normalisation/pair-generation
 * pipeline and uses the World-Cup-specific modules instead.
 *
 * Pipeline:
 *   1. Fetch market snapshot lists from both venues (Kalshi + Polymarket).
 *   2. Generate cross-venue candidate pairs using the WC pair matcher
 *      (filters to WC2026 markets internally, matches by team code).
 *   3. Classify each pair using the WC-specific equivalence policy.
 *   4. Fetch orderbooks *only* for the matched markets (not all markets).
 *   5. Calculate opportunities using the existing OpportunityCalculator.
 *   6. Simulate paper trades using the existing PaperTradeSimulator.
 *
 * @emergency Drop this when topic normalisation produces stable team keys
 * cross-venue and fold WC2026 markets into the generic scanner path.
 */

import { OpportunityCalculator } from "../../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../../arbitrage/domain/opportunity";
import { PaperTradeSimulation, PaperTradeSimulator } from "../../arbitrage/domain/paper-trade-simulator";
import { VenueClient, VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { WorldCupCandidatePair, buildWorldCupPairs } from "../domain/worldcup-pair-matcher";
import { classifyWorldCupPair } from "../domain/worldcup-equivalence-policy";

export interface WorldCupArbOpportunity {
  pair: WorldCupCandidatePair;
  opportunity: import("../../arbitrage/domain/opportunity").CrossVenueOpportunity;
  paperTradeSimulations: PaperTradeSimulation[];
}

export interface WorldCupArbResult {
  scannedAt: string;
  kalshiMarketCount: number;
  polymarketMarketCount: number;
  worldCupKalshi: number;
  worldCupPolymarket: number;
  candidatePairs: number;
  /** Opportunity count, after filtering by {@link WorldCupArbFinderOptions.minNetEdge}. */
  opportunities: WorldCupArbOpportunity[];
  timings: WorldCupArbTimings;
}

export interface WorldCupArbTimings {
  fetchMarketsMs: number;
  filterAndPairMs: number;
  fetchOrderbooksMs: number;
  calculateMs: number;
  totalMs: number;
}

export interface WorldCupArbFinderOptions {
  /** Wall-clock for the OpportunityCalculator. Defaults to `new Date().toISOString()`. */
  scanTimeUtc?: string;
  /** Flat fee-rate for both venues when no venue-specific fee model is supplied. Default: 0.01. */
  feeRate?: number;
  /** Kalshi-specific fee rate; overrides feeRate for Kalshi leg. Default: feeRate. */
  kalshiFeeRate?: number;
  /** Polymarket-specific fee rate; overrides feeRate for Polymarket leg. Default: feeRate. */
  polyFeeRate?: number;
  /** Minimum net edge to surface. Default: 0 (any non-negative net edge). Ignored when noFilter=true. */
  minNetEdge?: number;
  /** When true, skip edge filtering entirely — return all opportunities. Default: false. */
  noFilter?: boolean;
  /** Target USD notionals for paper-trade simulation. Default: [5, 25, 100]. */
  paperTradeNotionals?: number[];
  /** Adverse selection bps applied to hedge leg in paper-trade sim. Default: 25. */
  paperTradeAdverseSelectionBps?: number;
  /**
   * Max acceptable book age in ms. Books older than this are rejected by the
   * OpportunityCalculator's freshness guard before any edge is computed.
   * When omitted, the calculator's own default (60_000) applies. Piping this
   * through from the live-monitor ensures the finder and the defensive filter
   * in toVerifiedOutput() agree on the same threshold.
   */
  maxBookAgeMs?: number;
}

export interface WorldCupArbFinderDeps {
  kalshiClient: VenueClient;
  polymarketClient: VenueClient;
  opportunityCalculator?: OpportunityCalculator;
  paperTradeSimulator?: PaperTradeSimulator;
  /** Override the wall clock — useful for tests. */
  clock?: () => string;
}

const DEFAULT_OPTIONS = {
  feeRate: 0.01,
  minNetEdge: 0,
  paperTradeNotionals: [5, 25, 100] as number[],
  paperTradeAdverseSelectionBps: 25,
};

export class WorldCupArbFinder {
  constructor(private readonly deps: WorldCupArbFinderDeps) {}

  async find(options: WorldCupArbFinderOptions = {}): Promise<WorldCupArbResult> {
    const totalStart = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const scanTimeUtc = opts.scanTimeUtc ?? (this.deps.clock?.() ?? new Date().toISOString());
    const calculator = this.deps.opportunityCalculator ?? new OpportunityCalculator();
    const simulator = this.deps.paperTradeSimulator ?? new PaperTradeSimulator();

    // Step 1: fetch raw market lists from both venues in parallel.
    const fetchStart = Date.now();
    const [kalshiSnapshots, polymarketSnapshots] = await Promise.allSettled([
      this.deps.kalshiClient.listMarkets(),
      this.deps.polymarketClient.listMarkets(),
    ]);

    const kalshiMarkets = settled(kalshiSnapshots) ?? [];
    const polyMarkets = settled(polymarketSnapshots) ?? [];
    const fetchMarketsMs = Date.now() - fetchStart;

    // Step 2 + 3: classify to WC2026, build candidate pairs.
    const pairStart = Date.now();
    const pairs = buildWorldCupPairsAll([...kalshiMarkets, ...polyMarkets]);
    const filterAndPairMs = Date.now() - pairStart;

    // Step 4: fetch orderbooks only for the matched markets.
    const obStart = Date.now();
    const kalshiRelevantIds = new Set(pairs.map((p) => p.kalshiMarket.venueMarketId));
    const polyRelevantIds = new Set(pairs.map((p) => p.polymarketMarket.venueMarketId));
    const kalshiRelevantSnapshots = kalshiMarkets.filter((m) => kalshiRelevantIds.has(m.venueMarketId));
    const polyRelevantSnapshots = polyMarkets.filter((m) => polyRelevantIds.has(m.venueMarketId));

    const [kalshiBooksResult, polyBooksResult] = await Promise.allSettled([
      this.deps.kalshiClient.listOrderbooks(kalshiRelevantSnapshots),
      this.deps.polymarketClient.listOrderbooks(polyRelevantSnapshots),
    ]);
    const kalshiBooks = settled(kalshiBooksResult) ?? [];
    const polyBooks = settled(polyBooksResult) ?? [];
    const fetchOrderbooksMs = Date.now() - obStart;

    const booksByVenueId = new Map<string, MarketBook>();
    for (const book of [...kalshiBooks, ...polyBooks]) {
      booksByVenueId.set(`${book.venue}:${book.marketId}`, book);
    }

    // Step 5 + 6: calculate opportunities and run paper-trade simulations.
    const calcStart = Date.now();
    const opportunities: WorldCupArbOpportunity[] = [];

    const effectiveKalshiFee = opts.kalshiFeeRate ?? opts.feeRate;
    const effectivePolyFee = opts.polyFeeRate ?? opts.feeRate;
    const feeModels = {
      kalshi: { type: "flat" as const, rate: effectiveKalshiFee },
      polymarket: { type: "flat" as const, rate: effectivePolyFee },
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
          ...(opts.maxBookAgeMs !== undefined ? { maxBookAgeMs: opts.maxBookAgeMs } : {}),
        }
      );

      for (const op of opps) {
        const sims = simulator.simulate(op, {
          targetNotionalsUsd: opts.paperTradeNotionals,
          adverseSelectionBps: opts.paperTradeAdverseSelectionBps,
        });
        opportunities.push({ pair, opportunity: op, paperTradeSimulations: sims });
      }
    }
    const calculateMs = Date.now() - calcStart;

    // Count WC2026 markets per venue (from the pair set, which is already filtered).
    const worldCupKalshi = pairs.reduce<number>((n, p) => n + (p.kalshiMarket.venue === "kalshi" ? 1 : 0), 0);
    const worldCupPolymarket = pairs.reduce<number>((n, p) => n + (p.polymarketMarket.venue === "polymarket" ? 1 : 0), 0);

    return {
      scannedAt: scanTimeUtc,
      kalshiMarketCount: kalshiMarkets.length,
      polymarketMarketCount: polyMarkets.length,
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

function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

/**
 * Thin wrapper around `buildWorldCupPairs` imported from the domain module.
 * Kept here so the finder file is self-documenting without leaking domain
 * imports into the public interface.
 */
function buildWorldCupPairsAll(snapshots: VenueMarketSnapshot[]): WorldCupCandidatePair[] {
  return buildWorldCupPairs(snapshots);
}
