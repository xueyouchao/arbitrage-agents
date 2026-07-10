import { OpportunityCalculator, OpportunityCalculatorOptions } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import {
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair
} from "./scanner-repository";

/**
 * Owns the mapping from in-scan domain objects (venue orderbooks, reviewed
 * candidate pairs, normalized markets) to persistence DTOs (orderbook
 * snapshot artifacts and opportunities stamped with their source snapshot
 * ids). Extracted from {@link ReadOnlyScanner} so the scanner stays a
 * use-case coordinator and the artifact/provenance mapping lives in a
 * single, independently testable collaborator.
 *
 * Behavior is a verbatim lift of the scanner's former inline mapping; the
 * scanner's existing tests are the regression contract.
 */
export class ScanArtifactAssembler {
  /**
   * Map each venue orderbook to an {@link OrderbookSnapshotArtifact} keyed
   * by the matched normalized market. Books whose `venue:marketId` has no
   * matching normalized market are dropped (mirrors the scanner's previous
   * `flatMap`-to-empty behavior). Invalid ask prices (non-finite, <=0, >=1)
   * are normalized to `undefined`.
   */
  assembleOrderbookSnapshots(
    scanId: string,
    books: readonly MarketBook[],
    normalizedMarkets: readonly NormalizedMarket[]
  ): OrderbookSnapshotArtifact[] {
    const normalizedMarketByBookKey = new Map(
      normalizedMarkets.map((market) => [`${market.venue}:${market.venueMarketId}`, market])
    );
    return books.flatMap((book) => toOrderbookSnapshotArtifact(scanId, book, normalizedMarketByBookKey));
  }

  /**
   * For each reviewed candidate pair, look up both legs' books and
   * orderbook snapshots, run the opportunity calculator, and stamp every
   * emitted opportunity with the source snapshot ids. Pairs missing either
   * leg's book or snapshot contribute no opportunities, matching the
   * scanner's previous skip-on-missing behavior.
   */
  assembleOpportunities(
    reviewedCandidatePairs: readonly ReviewedCandidatePair[],
    books: readonly MarketBook[],
    orderbookSnapshots: readonly OrderbookSnapshotArtifact[],
    calculationAt: string,
    calculator: OpportunityCalculator,
    calculatorOptions?: Partial<OpportunityCalculatorOptions>
  ): OpportunityWithSourceSnapshots[] {
    const booksByKey = new Map(books.map((book) => [bookKey(book), book]));
    const orderbookSnapshotByBookKey = new Map(
      orderbookSnapshots.map((snapshot) => [`${snapshot.venue}:${snapshot.venueMarketId}`, snapshot])
    );
    return reviewedCandidatePairs.flatMap(({ pair, decision }) => {
      const kalshiKey = `${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`;
      const polymarketKey = `${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`;
      const kalshiBook = booksByKey.get(kalshiKey);
      const polymarketBook = booksByKey.get(polymarketKey);
      const kalshiSnapshot = orderbookSnapshotByBookKey.get(kalshiKey);
      const polymarketSnapshot = orderbookSnapshotByBookKey.get(polymarketKey);
      if (!kalshiBook || !polymarketBook || !kalshiSnapshot || !polymarketSnapshot) return [];
      return calculator
        .calculate(pair, decision, kalshiBook, polymarketBook, { now: calculationAt, ...calculatorOptions })
        .map((opportunity) => ({
          opportunity,
          kalshiOrderbookSnapshotId: kalshiSnapshot.id,
          polymarketOrderbookSnapshotId: polymarketSnapshot.id
        }));
    });
  }
}

function toOrderbookSnapshotArtifact(
  scanId: string,
  book: MarketBook,
  normalizedMarketByBookKey: Map<string, NormalizedMarket>
): OrderbookSnapshotArtifact[] {
  const normalizedMarket = normalizedMarketByBookKey.get(bookKey(book));
  if (!normalizedMarket) return [];

  return [
    {
      id: `${scanId}:${book.venue}:${book.marketId}:${book.capturedAt}`,
      scanRunId: scanId,
      normalizedMarketId: normalizedMarket.id,
      venue: book.venue,
      venueMarketId: book.marketId,
      yesAsk: validAsk(book.yesAsk),
      noAsk: validAsk(book.noAsk),
      yesAvailableUsd: book.yesAvailableUsd,
      noAvailableUsd: book.noAvailableUsd,
      rawPayload: toOrderbookRawPayload(book),
      capturedAt: book.capturedAt,
      stale: book.stale ?? false
    }
  ];
}

function toOrderbookRawPayload(book: MarketBook): Record<string, unknown> {
  return {
    sourcePayload: book.rawPayload ?? {},
    marketId: book.marketId,
    venue: book.venue,
    yesAsk: validAsk(book.yesAsk),
    noAsk: validAsk(book.noAsk),
    yesAvailableUsd: book.yesAvailableUsd,
    noAvailableUsd: book.noAvailableUsd,
    yesDepth: book.yesDepth ?? [],
    noDepth: book.noDepth ?? [],
    capturedAt: book.capturedAt,
    stale: book.stale ?? false
  };
}

function validAsk(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function bookKey(book: Pick<MarketBook, "venue" | "marketId">): string {
  return `${book.venue}:${book.marketId}`;
}