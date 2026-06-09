import { randomUUID } from "crypto";
import { redactSensitiveText } from "../../config/redaction";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { CandidatePair } from "../matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { CryptoMarketNormalizer } from "../matching/domain/crypto-market-normalizer";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueClient } from "../venues/domain/venue-market";
import { OpportunityWithSourceSnapshots, OrderbookSnapshotArtifact, ReviewedCandidatePair, ScannerRepository } from "./scanner-repository";
import { ScanFailureCategory, ScanMetrics, ScanResult } from "./scanner-result";

export interface ReadOnlyScannerDependencies {
  kalshiClient: VenueClient;
  polymarketClient: VenueClient;
  repository: ScannerRepository;
  now?: string;
  clock?: () => string;
}

export class ReadOnlyScanner {
  private readonly normalizer = new CryptoMarketNormalizer();
  private readonly pairGenerator = new CandidatePairGenerator();
  private readonly equivalencePolicy = new DeterministicEquivalencePolicy();
  private readonly opportunityCalculator = new OpportunityCalculator();

  constructor(private readonly dependencies: ReadOnlyScannerDependencies) {}

  async runOnce(): Promise<ScanResult> {
    const now = this.dependencies.clock ?? (() => this.dependencies.now ?? new Date().toISOString());
    const startedAt = now();
    let kalshiMarkets;
    let polymarketMarkets;
    let kalshiBooks;
    let polymarketBooks;
    const scanId = randomUUID();
    try {
      await this.dependencies.repository.saveScanRun({
        id: scanId,
        status: "running",
        startedAt,
        metrics: emptyMetrics()
      });
    } catch (_error) {
      return failedScanResult(scanId, startedAt, now(), emptyMetrics(), "persistence", _error);
    }

    try {
      [kalshiMarkets, polymarketMarkets] = await Promise.all([
        this.dependencies.kalshiClient.listMarkets(),
        this.dependencies.polymarketClient.listMarkets()
      ]);
      [kalshiBooks, polymarketBooks] = await Promise.all([
        this.dependencies.kalshiClient.listOrderbooks(kalshiMarkets),
        this.dependencies.polymarketClient.listOrderbooks(polymarketMarkets)
      ]);
    } catch (_error) {
      const failed = failedScanResult(scanId, startedAt, now(), emptyMetrics(), "fetch", _error);
      await saveFailedScanRun(this.dependencies.repository, failed);
      return failed;
    }

    const calculationAt = now();
    const snapshots = [...kalshiMarkets, ...polymarketMarkets];
    const fetchMetrics: ScanMetrics = { ...emptyMetrics(), marketsScanned: snapshots.length };
    let normalizedMarkets: NormalizedMarket[];
    let orderbookSnapshots: OrderbookSnapshotArtifact[];
    let candidatePairs: CandidatePair[];
    let reviewedCandidatePairs: ReviewedCandidatePair[];
    let opportunities: OpportunityWithSourceSnapshots[];

    try {
      normalizedMarkets = snapshots.map((snapshot) => this.normalizer.normalize(snapshot));
      const normalizedMarketByBookKey = new Map(normalizedMarkets.map((market) => [`${market.venue}:${market.venueMarketId}`, market]));
      orderbookSnapshots = [...kalshiBooks, ...polymarketBooks].flatMap((book) =>
        toOrderbookSnapshotArtifact(scanId, book, normalizedMarketByBookKey)
      );
      const orderbookSnapshotByBookKey = new Map(orderbookSnapshots.map((snapshot) => [`${snapshot.venue}:${snapshot.venueMarketId}`, snapshot]));
      candidatePairs = this.pairGenerator.generate(normalizedMarkets);
      reviewedCandidatePairs = candidatePairs.map((pair) => ({
        pair,
        decision: this.equivalencePolicy.classify(pair)
      }));
      const booksByKey = new Map([...kalshiBooks, ...polymarketBooks].map((book) => [bookKey(book), book]));
      opportunities = reviewedCandidatePairs.flatMap(({ pair, decision }) => {
        const kalshiKey = `${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`;
        const polymarketKey = `${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`;
        const kalshiBook = booksByKey.get(kalshiKey);
        const polymarketBook = booksByKey.get(polymarketKey);
        const kalshiSnapshot = orderbookSnapshotByBookKey.get(kalshiKey);
        const polymarketSnapshot = orderbookSnapshotByBookKey.get(polymarketKey);
        if (!kalshiBook || !polymarketBook || !kalshiSnapshot || !polymarketSnapshot) return [];
        return this.opportunityCalculator
          .calculate(pair, decision, kalshiBook, polymarketBook, { now: calculationAt })
          .map((opportunity) => ({
            opportunity,
            kalshiOrderbookSnapshotId: kalshiSnapshot.id,
            polymarketOrderbookSnapshotId: polymarketSnapshot.id
          }));
      });
    } catch (_error) {
      const failed = failedScanResult(scanId, startedAt, now(), fetchMetrics, "processing", _error);
      await saveFailedScanRun(this.dependencies.repository, failed);
      return failed;
    }

    const result: ScanResult & { status: "succeeded" } = {
      id: scanId,
      status: "succeeded",
      startedAt,
      metrics: {
        marketsScanned: snapshots.length,
        normalizedMarkets: normalizedMarkets.length,
        candidatePairs: candidatePairs.length,
        opportunitiesFound: opportunities.length,
        llmEvaluations: 0
      }
    };

    try {
      return await this.dependencies.repository.saveCompletedScan({
        scanRun: result,
        completeScanRun: (scanRun) => ({ ...scanRun, completedAt: now() }),
        snapshots,
        normalizedMarkets,
        candidatePairs: reviewedCandidatePairs,
        orderbookSnapshots,
        opportunities
      });
    } catch (_error) {
      const failed = failedScanResult(scanId, startedAt, now(), result.metrics, "persistence", _error);
      await saveFailedScanRun(this.dependencies.repository, failed);
      return failed;
    }
  }
}

async function saveFailedScanRun(repository: ScannerRepository, failed: ScanResult): Promise<void> {
  try {
    await repository.saveScanRun(failed);
  } catch {
    // The caller still needs the sanitized original failure even if persisting the failure marker also fails.
  }
}

function failedScanResult(
  id: string,
  startedAt: string,
  completedAt: string,
  metrics: ScanMetrics,
  failureCategory: ScanFailureCategory,
  error: unknown
): ScanResult {
  const failureReason = sanitizeFailureReason(error);
  const failedMetrics = { ...metrics, failureCategory, failureReason };

  return {
    id,
    status: "failed",
    startedAt,
    completedAt,
    metrics: failedMetrics,
    failureCategory,
    failureReason
  };
}

function emptyMetrics(): ScanMetrics {
  return { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 };
}

function sanitizeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/token[_-]?id=[^\s&]+/gi, "token_id=[redacted]")
    .replace(/(api[_-]?key|authorization|password|secret|token)=\S+/gi, "$1=[redacted]")
    .slice(0, 200);
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
