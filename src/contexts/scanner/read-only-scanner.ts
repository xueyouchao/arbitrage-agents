import { randomUUID } from "crypto";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { CryptoMarketNormalizer } from "../matching/domain/crypto-market-normalizer";
import { VenueClient } from "../venues/domain/venue-market";
import { ReviewedCandidatePair, ScannerRepository } from "./scanner-repository";
import { ScanResult } from "./scanner-result";

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
    const now = this.dependencies.clock ?? (() => new Date().toISOString());
    const startedAt = this.dependencies.now ?? now();
    let kalshiMarkets;
    let polymarketMarkets;
    let kalshiBooks;
    let polymarketBooks;
    const scanId = randomUUID();
    await this.dependencies.repository.saveScanRun({
      id: scanId,
      status: "running",
      startedAt,
      metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 }
    });

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
      const failed: ScanResult = {
        id: scanId,
        status: "failed",
        startedAt,
        completedAt: now(),
        metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 }
      };
      await this.dependencies.repository.saveScanRun(failed);
      return failed;
    }

    const calculationAt = now();
    const snapshots = [...kalshiMarkets, ...polymarketMarkets];
    const normalizedMarkets = snapshots.map((snapshot) => this.normalizer.normalize(snapshot));
    const candidatePairs = this.pairGenerator.generate(normalizedMarkets);
    const reviewedCandidatePairs: ReviewedCandidatePair[] = candidatePairs.map((pair) => ({
      pair,
      decision: this.equivalencePolicy.classify(pair)
    }));
    const booksByKey = new Map([...kalshiBooks, ...polymarketBooks].map((book) => [bookKey(book), book]));
    const opportunities = reviewedCandidatePairs.flatMap(({ pair, decision }) => {
      const kalshiBook = booksByKey.get(`${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`);
      const polymarketBook = booksByKey.get(`${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`);
      if (!kalshiBook || !polymarketBook) return [];
      return this.opportunityCalculator.calculate(pair, decision, kalshiBook, polymarketBook, { now: calculationAt });
    });

    const result: ScanResult & { status: "succeeded" } = {
      id: scanId,
      status: "succeeded",
      startedAt,
      completedAt: now(),
      metrics: {
        marketsScanned: snapshots.length,
        normalizedMarkets: normalizedMarkets.length,
        candidatePairs: candidatePairs.length,
        opportunitiesFound: opportunities.length,
        llmEvaluations: 0
      }
    };

    try {
      await this.dependencies.repository.saveCompletedScan({
        scanRun: result,
        snapshots,
        normalizedMarkets,
        candidatePairs: reviewedCandidatePairs,
        opportunities
      });
      return result;
    } catch (_error) {
      const failed: ScanResult = { ...result, status: "failed", completedAt: now() };
      await this.dependencies.repository.saveScanRun(failed);
      return failed;
    }
  }
}

function bookKey(book: MarketBook): string {
  return `${book.venue}:${book.marketId}`;
}

