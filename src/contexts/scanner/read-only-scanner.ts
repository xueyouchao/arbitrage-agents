import { randomUUID } from "crypto";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { CryptoMarketNormalizer } from "../matching/domain/crypto-market-normalizer";
import { VenueClient } from "../venues/domain/venue-market";
import { ScannerRepository } from "./in-memory-scanner-repository";
import { ScanResult } from "./scanner-result";

export interface ReadOnlyScannerDependencies {
  kalshiClient: VenueClient;
  polymarketClient: VenueClient;
  repository: ScannerRepository;
  now?: string;
}

export class ReadOnlyScanner {
  private readonly normalizer = new CryptoMarketNormalizer();
  private readonly pairGenerator = new CandidatePairGenerator();
  private readonly equivalencePolicy = new DeterministicEquivalencePolicy();
  private readonly opportunityCalculator = new OpportunityCalculator();

  constructor(private readonly dependencies: ReadOnlyScannerDependencies) {}

  async runOnce(): Promise<ScanResult> {
    const startedAt = this.dependencies.now ?? new Date().toISOString();
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
        completedAt: new Date().toISOString(),
        metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 }
      };
      await this.dependencies.repository.saveScanRun(failed);
      return failed;
    }

    const snapshots = [...kalshiMarkets, ...polymarketMarkets];
    const normalizedMarkets = snapshots.map((snapshot) => this.normalizer.normalize(snapshot));
    const candidatePairs = this.pairGenerator.generate(normalizedMarkets);
    const booksByKey = new Map([...kalshiBooks, ...polymarketBooks].map((book) => [bookKey(book), book]));
    const opportunities = candidatePairs.flatMap((pair) => {
      const decision = this.equivalencePolicy.classify(pair);
      const kalshiBook = booksByKey.get(`${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`);
      const polymarketBook = booksByKey.get(`${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`);
      if (!kalshiBook || !polymarketBook) return [];
      return this.opportunityCalculator.calculate(pair, decision, kalshiBook, polymarketBook, { now: startedAt });
    });

    const result: ScanResult = {
      id: scanId,
      status: "succeeded",
      startedAt,
      completedAt: startedAt,
      metrics: {
        marketsScanned: snapshots.length,
        normalizedMarkets: normalizedMarkets.length,
        candidatePairs: candidatePairs.length,
        opportunitiesFound: opportunities.length,
        llmEvaluations: 0
      }
    };

    try {
      await this.dependencies.repository.saveSnapshots(snapshots);
      await this.dependencies.repository.saveNormalizedMarkets(normalizedMarkets);
      await this.dependencies.repository.saveCandidatePairs(candidatePairs);
      await this.dependencies.repository.saveOpportunities(opportunities);
      await this.dependencies.repository.saveScanRun(result);
      return result;
    } catch (_error) {
      const failed: ScanResult = { ...result, status: "failed", completedAt: new Date().toISOString() };
      await this.dependencies.repository.saveScanRun(failed);
      return failed;
    }
  }
}

function bookKey(book: MarketBook): string {
  return `${book.venue}:${book.marketId}`;
}

