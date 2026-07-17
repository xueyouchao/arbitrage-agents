// PMXT Orderbook Comparison.
//
// Compares PMXT market books against venue (Kalshi/Polymarket) market books
// to detect price edges. Designed for the PMXT shadow read path: it takes
// a single PMXT book and a single venue book and returns zero or more
// comparison results, one per side (YES/NO) where PMXT offers a better price.
//
// Key behaviors:
//   - No synthetic prices: YES/NO inversion (1 - price) is never used.
//     A missing ask on either side means that side is not compared.
//   - Time eligibility: books older than `maxBookAgeMs` are excluded.
//   - Stale books: stale books are excluded from executable comparisons
//     but remain available for coverage/operational metrics.
//   - Tick ordering: depth levels are sorted by price ascending.
//   - Size units: all sizes must be positive; zero-size levels are dropped.
//   - Source timestamps: recorded separately from receipt/comparison timestamps.

import { PmxtMarketBook, PmxtPriceLevel, roundUsd } from "../../venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import { MarketBook } from "../../arbitrage/domain/opportunity";

export interface PmxtOrderbookComparisonConfig {
  maxBookAgeMs: number;
  minTopOfBookEdge: number;
  clock: () => number;
}

export interface PmxtOrderbookComparisonResult {
  side: "YES" | "NO";
  pmxtPrice: number;
  venuePrice: number;
  edge: number;
  pmxtDepth: PmxtPriceLevel[];
  venueDepth: PmxtPriceLevel[];
  pmxtExecutableUsd: number;
  venueExecutableUsd: number;
  pmxtCapturedAt: string;
  venueCapturedAt: string;
  comparedAt: string;
}

export function comparePmxtOrderbooks(
  pmxt: PmxtMarketBook,
  venue: MarketBook,
  config: PmxtOrderbookComparisonConfig
): PmxtOrderbookComparisonResult[] {
  const now = config.clock();
  const comparedAt = new Date(now).toISOString();

  // Time eligibility check
  if (!isTimeEligible(pmxt.capturedAt, now, config.maxBookAgeMs)) return [];
  if (!isTimeEligible(venue.capturedAt, now, config.maxBookAgeMs)) return [];

  // Stale book check — exclude from executable comparisons
  if (pmxt.stale || venue.stale) return [];

  const results: PmxtOrderbookComparisonResult[] = [];

  tryCompareSide("YES", pmxt.yesAsk, venue.yesAsk);
  tryCompareSide("NO", pmxt.noAsk, venue.noAsk);

  return results;

  function tryCompareSide(side: "YES" | "NO", pmxtAsk: number | undefined, venueAsk: number): void {
    if (isValidAsk(pmxtAsk) && isValidAsk(venueAsk)) {
      const edge = venueAsk - pmxtAsk;
      if (edge >= config.minTopOfBookEdge) {
        results.push(buildResult(side, pmxt, venue, edge, comparedAt));
      }
    }
  }

  return results;
}

function buildResult(
  side: "YES" | "NO",
  pmxt: PmxtMarketBook,
  venue: MarketBook,
  edge: number,
  comparedAt: string
): PmxtOrderbookComparisonResult {
  const pmxtDepth = side === "YES" ? pmxt.yesDepth : pmxt.noDepth;
  const venueDepth = side === "YES" ? (venue.yesDepth ?? []) : (venue.noDepth ?? []);
  const pmxtPrice = side === "YES" ? pmxt.yesAsk! : pmxt.noAsk!;
  const venuePrice = side === "YES" ? venue.yesAsk : venue.noAsk;

  const validPmxtDepth = validDepth(pmxtDepth);
  const validVenueDepth = validDepth(venueDepth);

  return {
    side,
    pmxtPrice,
    venuePrice,
    edge: roundEdge(edge),
    pmxtDepth: validPmxtDepth,
    venueDepth: validVenueDepth,
    pmxtExecutableUsd: roundUsd(executableUsd(validPmxtDepth)),
    venueExecutableUsd: roundUsd(executableUsd(validVenueDepth)),
    pmxtCapturedAt: pmxt.capturedAt,
    venueCapturedAt: venue.capturedAt,
    comparedAt,
  };
}

function validDepth(levels: PmxtPriceLevel[] | undefined): PmxtPriceLevel[] {
  return (levels ?? [])
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.price < 1 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
}

function executableUsd(levels: PmxtPriceLevel[]): number {
  return levels.reduce((sum, l) => sum + l.price * l.size, 0);
}

function isValidAsk(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1;
}

function isTimeEligible(capturedAt: string, now: number, maxAgeMs: number): boolean {
  if (!capturedAt) return true; // missing timestamp → assume eligible
  const age = now - new Date(capturedAt).getTime();
  if (!Number.isFinite(age)) return true; // unparseable timestamp → assume eligible
  return age <= maxAgeMs;
}

function roundEdge(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
