import { randomUUID } from "crypto";
import { redactSensitiveText } from "../../config/redaction";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { LlmEvaluationRecord, LlmEvaluationRequest } from "../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { CryptoMarketNormalizer } from "../matching/domain/crypto-market-normalizer";
import { CryptoAsset, EventType, MarketOperator, NormalizedMarket, PayoffType, Topic } from "../matching/domain/normalized-market";
import { VenueClient } from "../venues/domain/venue-market";
import {
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair,
  ReviewedNormalizedMarket,
  ScannerRepository
} from "./scanner-repository";
import { ScanFailureCategory, ScanMetrics, ScanResult } from "./scanner-result";

export interface ReadOnlyScannerDependencies {
  kalshiClient: VenueClient;
  polymarketClient: VenueClient;
  repository: ScannerRepository;
  llmGateway?: ScannerLlmGateway;
  llmPromptVersion?: string;
  llmModel?: string;
  scannerLlmMaxEvaluationsPerScan?: number;
  now?: string;
  clock?: () => string;
}

export interface ScannerLlmGateway {
  evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord>;
}

interface LlmScanBudget {
  maxEvaluations: number;
  evaluations: number;
  skipped: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
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
    const llmBudget = newLlmScanBudget(this.dependencies);
    let normalizedMarketReviews: ReviewedNormalizedMarket[];
    let normalizedMarkets: NormalizedMarket[];
    let orderbookSnapshots: OrderbookSnapshotArtifact[];
    let candidatePairs: CandidatePair[];
    let reviewedCandidatePairs: ReviewedCandidatePair[];
    let opportunities: OpportunityWithSourceSnapshots[];

    try {
      normalizedMarkets = snapshots.map((snapshot) => this.normalizer.normalize(snapshot));
      normalizedMarketReviews = await this.reviewAmbiguousMarkets(normalizedMarkets, llmBudget);
      normalizedMarkets = normalizedMarketReviews.map((review) => review.market);
      const normalizedMarketByBookKey = new Map(normalizedMarkets.map((market) => [`${market.venue}:${market.venueMarketId}`, market]));
      orderbookSnapshots = [...kalshiBooks, ...polymarketBooks].flatMap((book) =>
        toOrderbookSnapshotArtifact(scanId, book, normalizedMarketByBookKey)
      );
      const orderbookSnapshotByBookKey = new Map(orderbookSnapshots.map((snapshot) => [`${snapshot.venue}:${snapshot.venueMarketId}`, snapshot]));
      candidatePairs = this.pairGenerator.generate(normalizedMarkets);
      reviewedCandidatePairs = await this.reviewCandidatePairs(candidatePairs, llmBudget);
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
        ...llmMetrics(llmBudget)
      }
    };

    try {
      return await this.dependencies.repository.saveCompletedScan({
        scanRun: result,
        completeScanRun: (scanRun) => ({ ...scanRun, completedAt: now() }),
        snapshots,
        normalizedMarkets: normalizedMarketReviews,
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

  private async reviewAmbiguousMarkets(markets: NormalizedMarket[], budget: LlmScanBudget): Promise<ReviewedNormalizedMarket[]> {
    const reviewedMarkets: ReviewedNormalizedMarket[] = [];
    for (const market of markets) {
      if (!this.dependencies.llmGateway || !shouldRequestLlmNormalization(market)) {
        reviewedMarkets.push({ market });
        continue;
      }

      const llmEvaluation = await this.evaluateWithBudget(budget, {
        taskType: "market_normalization",
        promptVersion: this.dependencies.llmPromptVersion ?? "scanner-normalization-v1",
        model: this.dependencies.llmModel ?? "scanner-default",
        input: toLlmMarketInput(market)
      });

      reviewedMarkets.push(llmEvaluation ? applyLlmNormalization(market, llmEvaluation) : { market });
    }
    return reviewedMarkets;
  }

  private async reviewCandidatePairs(pairs: CandidatePair[], budget: LlmScanBudget): Promise<ReviewedCandidatePair[]> {
    const reviewedPairs: ReviewedCandidatePair[] = [];
    for (const pair of pairs) {
      reviewedPairs.push(await this.reviewCandidatePair(pair, budget));
    }
    return reviewedPairs;
  }

  private async reviewCandidatePair(pair: CandidatePair, budget: LlmScanBudget): Promise<ReviewedCandidatePair> {
    const decision = this.equivalencePolicy.classify(pair);
    if (!this.dependencies.llmGateway || !shouldRequestLlmEquivalence(decision)) {
      return { pair, decision };
    }

    const llmEvaluation = await this.evaluateWithBudget(budget, {
      taskType: "market_equivalence",
      promptVersion: this.dependencies.llmPromptVersion ?? "scanner-equivalence-v1",
      model: this.dependencies.llmModel ?? "scanner-default",
      input: toLlmEquivalenceInput(pair, decision)
    });

    return llmEvaluation ? { pair, decision: decisionWithLlmReason(decision, llmEvaluation), llmEvaluation } : { pair, decision };
  }

  private async evaluateWithBudget(budget: LlmScanBudget, request: LlmEvaluationRequest): Promise<LlmEvaluationRecord | undefined> {
    if (!this.dependencies.llmGateway) return undefined;
    if (budget.evaluations >= budget.maxEvaluations) {
      budget.skipped += 1;
      return undefined;
    }

    const record = await this.dependencies.llmGateway.evaluate(request);
    budget.evaluations += 1;
    budget.promptTokens += record.promptTokens;
    budget.completionTokens += record.completionTokens;
    budget.estimatedCostUsd += record.estimatedCostUsd;
    budget.latencyMs += record.latencyMs;
    return record;
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

function newLlmScanBudget(dependencies: ReadOnlyScannerDependencies): LlmScanBudget {
  return {
    maxEvaluations: dependencies.llmGateway ? dependencies.scannerLlmMaxEvaluationsPerScan ?? 25 : 0,
    evaluations: 0,
    skipped: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0
  };
}

function llmMetrics(budget: LlmScanBudget): Pick<ScanMetrics, "llmEvaluations" | "llmEvaluationsSkipped" | "llmPromptTokens" | "llmCompletionTokens" | "llmEstimatedCostUsd" | "llmLatencyMs"> {
  return {
    llmEvaluations: budget.evaluations,
    llmEvaluationsSkipped: budget.skipped,
    llmPromptTokens: budget.promptTokens,
    llmCompletionTokens: budget.completionTokens,
    llmEstimatedCostUsd: budget.estimatedCostUsd,
    llmLatencyMs: budget.latencyMs
  };
}

function shouldRequestLlmNormalization(market: NormalizedMarket): boolean {
  return market.confidence < 0.8 || market.ambiguityFlags.length > 0;
}

function shouldRequestLlmEquivalence(decision: EquivalenceDecision): boolean {
  return decision.equivalenceClass === "B" || decision.equivalenceClass === "D";
}

function applyLlmNormalization(market: NormalizedMarket, llmEvaluation: LlmEvaluationRecord): ReviewedNormalizedMarket {
  if (llmEvaluation.status !== "succeeded" || !llmEvaluation.parsedOutput) {
    return { market, llmEvaluation };
  }

  const normalized = llmEvaluation.parsedOutput as unknown as LlmNormalizationOutput;
  return {
    market: {
      ...market,
      topic: normalized.topic,
      eventType: normalized.eventType,
      asset: normalized.asset ?? undefined,
      threshold: normalized.threshold ?? undefined,
      operator: normalized.operator ?? undefined,
      deadline: normalized.deadline ?? undefined,
      timezone: normalized.timezone ?? undefined,
      resolutionSource: normalized.resolutionSource ?? undefined,
      payoffType: normalized.payoffType,
      ambiguityFlags: uniqueStrings(["llm_normalized", ...normalized.ambiguityFlags]),
      confidence: normalized.confidence
    },
    llmEvaluation
  };
}

interface LlmNormalizationOutput {
  topic: Topic;
  eventType: EventType;
  asset: CryptoAsset | null;
  threshold: number | null;
  operator: MarketOperator | null;
  deadline: string | null;
  timezone: string | null;
  resolutionSource: string | null;
  payoffType: PayoffType;
  confidence: number;
  ambiguityFlags: string[];
}

function decisionWithLlmReason(decision: EquivalenceDecision, llmEvaluation: LlmEvaluationRecord): EquivalenceDecision {
  if (llmEvaluation.status !== "succeeded" || !llmEvaluation.parsedOutput) {
    return { ...decision, reasons: [...decision.reasons, `llm_${llmEvaluation.status}`] };
  }

  const verdict = llmEvaluation.parsedOutput as unknown as { equivalent: boolean; confidence: number };
  if (!verdict.equivalent && verdict.confidence >= 0.7) {
    return { ...decision, equivalenceClass: "C", decision: "reject", reasons: [...decision.reasons, "llm_refuted_equivalence"] };
  }

  if (verdict.equivalent && verdict.confidence >= 0.7) {
    return {
      ...decision,
      equivalenceClass: decision.equivalenceClass === "D" ? "B" : decision.equivalenceClass,
      decision: decision.decision === "human_review" ? "alert_only" : decision.decision,
      reasons: [...decision.reasons, "llm_supported_equivalence"]
    };
  }

  return { ...decision, reasons: [...decision.reasons, "llm_inconclusive"] };
}

function toLlmEquivalenceInput(pair: CandidatePair, decision: EquivalenceDecision): Record<string, unknown> {
  return {
    pairId: pair.id,
    deterministicDecision: decision,
    kalshiMarket: toLlmMarketInput(pair.kalshiMarket),
    polymarketMarket: toLlmMarketInput(pair.polymarketMarket)
  };
}

function toLlmMarketInput(market: NormalizedMarket): Record<string, unknown> {
  return {
    venue: market.venue,
    venueMarketId: market.venueMarketId,
    title: market.title,
    rawResolutionText: market.rawResolutionText,
    topic: market.topic,
    eventType: market.eventType,
    asset: market.asset,
    threshold: market.threshold,
    operator: market.operator,
    deadline: market.deadline,
    timezone: market.timezone,
    resolutionSource: market.resolutionSource,
    payoffType: market.payoffType,
    ambiguityFlags: market.ambiguityFlags,
    confidence: market.confidence
  };
}

function sanitizeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/token[_-]?id=[^\s&]+/gi, "token_id=[redacted]")
    .replace(/(api[_-]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;}&]+/gi, "$1$2[REDACTED]")
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
