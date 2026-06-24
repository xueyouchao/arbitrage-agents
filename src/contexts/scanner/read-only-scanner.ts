import { randomUUID } from "crypto";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { PaperTradeSimulation, PaperTradeSimulator } from "../arbitrage/domain/paper-trade-simulator";
import { LlmEvaluationRecord, LlmEvaluationRequest } from "../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { MarketNormalizer } from "../matching/domain/market-normalizer";
import { EventType, MarketOperator, NormalizedMarket, PayoffType, Topic } from "../matching/domain/normalized-market";
import { sanitizeFailureReason } from "../shared/sanitize-failure-reason";
import { VenueClient } from "../venues/domain/venue-market";
import { ScanArtifactAssembler } from "./scan-artifact-assembler";
import {
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair,
  ReviewedNormalizedMarket,
  ScannerRepository
} from "./scanner-repository";
import { ScanFailureCategory, ScanMetrics, ScanResult } from "./scanner-result";
import { ScanTelemetryReporter } from "./sentry-scan-telemetry-reporter";

export interface ReadOnlyScannerDependencies {
  kalshiClient: VenueClient;
  polymarketClient: VenueClient;
  repository: ScannerRepository;
  llmGateway?: ScannerLlmGateway;
  llmPromptVersion?: string;
  llmModel?: string;
  scannerLlmMaxEvaluationsPerScan?: number;
  // Phase 3 #6: optional paper-trade simulator. When absent, the scan
  // emits zero sims and the scanner continues unaffected. The simulator
  // is wrapped in try/catch so a single malformed opportunity can never
  // fail the scan.
  paperTradeSimulator?: PaperTradeSimulator;
  // Optional telemetry reporter for Sentry scan metrics, venue
  // health, opportunity alerts, and staleness warnings. When absent,
  // no telemetry is emitted and the scanner behaves unchanged.
  telemetryReporter?: ScanTelemetryReporter;
  now?: string;
  clock?: () => string;
}

export interface ScannerLlmGateway {
  evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord>;
  findCached?(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord | undefined>;
}

interface LlmScanBudget {
  maxEvaluations: number;
  evaluations: number;
  skipped: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  cacheHits: number;
  freshEvaluations: number;
  normalizationEvaluations: number;
  equivalenceEvaluations: number;
  // Reserve a small amount of fresh-work budget for candidate-pair
  // equivalence so market normalization cannot starve the review this
  // integration was added for. Keep the reserve small so unused equivalence
  // capacity does not waste half of the scan budget.
  maxNormalizationEvaluations: number;
  maxEquivalenceEvaluations: number;
  normalizationSkipped: number;
  equivalenceSkipped: number;
}

export class ReadOnlyScanner {
  private readonly normalizer = new MarketNormalizer();
  private readonly pairGenerator = new CandidatePairGenerator();
  private readonly equivalencePolicy = new DeterministicEquivalencePolicy();
  private readonly opportunityCalculator = new OpportunityCalculator();
  // Owns artifact/provenance mapping (orderbook snapshot DTOs and
  // source-snapshot-id wiring on opportunities) so the scanner stays a
  // use-case coordinator. Architecture suggestion #1 from the
  // 2026-06-03 handoff.
  private readonly artifactAssembler = new ScanArtifactAssembler();

  constructor(private readonly dependencies: ReadOnlyScannerDependencies) {}

  async runOnce(scanRunId?: string): Promise<ScanResult> {
    const now = this.dependencies.clock ?? (() => this.dependencies.now ?? new Date().toISOString());
    const startedAt = now();
    let kalshiMarkets;
    let polymarketMarkets;
    let kalshiBooks;
    let polymarketBooks;
    const scanId = scanRunId ?? randomUUID();
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

    let kalshiFetchLatencyMs = 0;
    let polymarketFetchLatencyMs = 0;
    let kalshiMarketCount = 0;
    let polymarketMarketCount = 0;
    let kalshiFetchSucceeded = false;
    let polymarketFetchSucceeded = false;

    // Fetch markets from both venues in parallel using allSettled so
    // one venue failure does not mask the other's success. Each venue's
    // promise is wrapped with .finally() to capture per-venue end times
    // regardless of success or failure (fixes misleading 0ms latency).
    // End timestamps default to start so unupdated values contribute 0ms.
    const kalshiMarketsStart = Date.now();
    const polymarketMarketsStart = Date.now();
    let kalshiMarketsEnd = kalshiMarketsStart;
    let polymarketMarketsEnd = polymarketMarketsStart;
    const [kalshiMarketsResult, polymarketMarketsResult] = await Promise.allSettled([
      this.dependencies.kalshiClient.listMarkets().finally(() => { kalshiMarketsEnd = Date.now(); }),
      this.dependencies.polymarketClient.listMarkets().finally(() => { polymarketMarketsEnd = Date.now(); })
    ]);

    if (kalshiMarketsResult.status === "fulfilled") {
      kalshiMarkets = kalshiMarketsResult.value;
      kalshiMarketCount = kalshiMarkets.length;
      kalshiFetchSucceeded = true;
    }
    if (polymarketMarketsResult.status === "fulfilled") {
      polymarketMarkets = polymarketMarketsResult.value;
      polymarketMarketCount = polymarketMarkets.length;
      polymarketFetchSucceeded = true;
    }

    // Fetch orderbooks for each venue independently. A venue that failed
    // listMarkets() gets an empty orderbook list (no fetch attempted).
    // End timestamps default to start so skipped fetches contribute 0ms.
    const kalshiBooksStart = Date.now();
    const polymarketBooksStart = Date.now();
    let kalshiBooksEnd = kalshiBooksStart;
    let polymarketBooksEnd = polymarketBooksStart;
    const [kalshiBooksResult, polymarketBooksResult] = await Promise.allSettled([
      kalshiMarkets
        ? this.dependencies.kalshiClient.listOrderbooks(kalshiMarkets).finally(() => { kalshiBooksEnd = Date.now(); })
        : Promise.resolve([]),
      polymarketMarkets
        ? this.dependencies.polymarketClient.listOrderbooks(polymarketMarkets).finally(() => { polymarketBooksEnd = Date.now(); })
        : Promise.resolve([])
    ]);

    if (kalshiBooksResult.status === "fulfilled") {
      kalshiBooks = kalshiBooksResult.value;
    } else {
      kalshiFetchSucceeded = false;
    }
    if (polymarketBooksResult.status === "fulfilled") {
      polymarketBooks = polymarketBooksResult.value;
    } else {
      polymarketFetchSucceeded = false;
    }

    kalshiFetchLatencyMs = (kalshiMarketsEnd - kalshiMarketsStart) + (kalshiBooksEnd - kalshiBooksStart);
    polymarketFetchLatencyMs = (polymarketMarketsEnd - polymarketMarketsStart) + (polymarketBooksEnd - polymarketBooksStart);

    // Ensure defaults so downstream spread operations don't throw.
    kalshiMarkets = kalshiMarkets ?? [];
    polymarketMarkets = polymarketMarkets ?? [];
    kalshiBooks = kalshiBooks ?? [];
    polymarketBooks = polymarketBooks ?? [];

    // Report per-venue fetch telemetry based on each venue's actual result.
    try {
      this.dependencies.telemetryReporter?.reportVenueFetch({
        venue: "kalshi", latencyMs: kalshiFetchLatencyMs, success: kalshiFetchSucceeded, marketCount: kalshiMarketCount
      });
      this.dependencies.telemetryReporter?.reportVenueFetch({
        venue: "polymarket", latencyMs: polymarketFetchLatencyMs, success: polymarketFetchSucceeded, marketCount: polymarketMarketCount
      });
    } catch { /* telemetry isolation */ }

    // Fail the scan when no venue produced usable data. This covers
    // both venues failing outright, or one failing while the other
    // succeeded but returned zero markets/books.
    const noKalshiData = !kalshiFetchSucceeded || kalshiMarketCount === 0;
    const noPolymarketData = !polymarketFetchSucceeded || polymarketMarketCount === 0;
    const noUsableData = noKalshiData && noPolymarketData;
    if (noUsableData) {
      // Aggregate errors from both venues when both fail, so operators
      // see all failure context rather than an arbitrary preference order.
      // Inspect all 4 results (markets + orderbooks) to capture orderbook
      // failures too.
      const errors: string[] = [];
      const extractError = (result: PromiseSettledResult<unknown>, venue: string, phase: string): void => {
        if (result.status === "rejected") {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          errors.push(`${venue} ${phase}: ${reason}`);
        }
      };
      extractError(kalshiMarketsResult, "kalshi", "markets");
      extractError(kalshiBooksResult, "kalshi", "orderbooks");
      extractError(polymarketMarketsResult, "polymarket", "markets");
      extractError(polymarketBooksResult, "polymarket", "orderbooks");
      const combinedError = errors.length > 0
        ? new Error(`All venues failed: ${errors.join("; ")}`)
        : new Error("No venue produced usable market data");
      const failed = failedScanResult(scanId, startedAt, now(), emptyMetrics(), "fetch", combinedError);
      await saveFailedScanRun(this.dependencies.repository, failed);
      try {
        this.dependencies.telemetryReporter?.reportScanMetrics({
          status: "failed",
          marketsScanned: 0,
          normalizedMarkets: 0,
          candidatePairs: 0,
          opportunitiesFound: 0,
          llmEvaluations: 0,
          durationMs: new Date(now()).getTime() - new Date(startedAt).getTime()
        });
      } catch { /* telemetry isolation */ }
      return failed;
    }

    // At this point at least one venue returned markets and orderbooks.
    const calculationAt = now();
    const snapshots = [...kalshiMarkets, ...polymarketMarkets];
    const fetchMetrics: ScanMetrics = { ...emptyMetrics(), marketsScanned: snapshots.length };
    const llmBudget = newLlmScanBudget(this.dependencies);
    if (this.dependencies.llmGateway && llmBudget.maxEvaluations > 0) {
      console.log(
        `[scanner:llm:budget] scanId=${scanId} model=${this.dependencies.llmModel ?? "scanner-default"} ` +
          `totalCap=${llmBudget.maxEvaluations} normalizationCap=${llmBudget.maxNormalizationEvaluations} equivalenceCap=${llmBudget.maxEquivalenceEvaluations}`
      );
    }
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
      const books = [...kalshiBooks, ...polymarketBooks];
      orderbookSnapshots = this.artifactAssembler.assembleOrderbookSnapshots(scanId, books, normalizedMarkets);
      candidatePairs = this.pairGenerator.generate(normalizedMarkets);
      reviewedCandidatePairs = await this.reviewCandidatePairs(candidatePairs, llmBudget);
      opportunities = this.artifactAssembler.assembleOpportunities(
        reviewedCandidatePairs,
        books,
        orderbookSnapshots,
        calculationAt,
        this.opportunityCalculator
      );
      // Report stale data telemetry. The orderbook snapshots carry a
      // `stale` flag set by the venue client when data is older than
      // expected.
      try {
        const staleSnapshots = orderbookSnapshots.filter((s) => s.stale);
        if (staleSnapshots.length > 0) {
          const maxStaleMs = staleSnapshots.reduce((max, s) => {
            const age = new Date(calculationAt).getTime() - new Date(s.capturedAt).getTime();
            return Math.max(max, age);
          }, 0);
          this.dependencies.telemetryReporter?.reportStaleData({
            staleCount: staleSnapshots.length,
            totalMarkets: orderbookSnapshots.length,
            maxStalenessMs: maxStaleMs
          });
        }
      } catch { /* telemetry isolation */ }
    } catch (_error) {
      const failed = failedScanResult(scanId, startedAt, now(), fetchMetrics, "processing", _error);
      await saveFailedScanRun(this.dependencies.repository, failed);
      try {
        this.dependencies.telemetryReporter?.reportScanMetrics({
          status: "failed",
          marketsScanned: fetchMetrics.marketsScanned,
          normalizedMarkets: 0,
          candidatePairs: 0,
          opportunitiesFound: 0,
          llmEvaluations: 0,
          durationMs: new Date(now()).getTime() - new Date(startedAt).getTime()
        });
      } catch { /* telemetry isolation */ }
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

    if (this.dependencies.llmGateway && llmBudget.maxEvaluations > 0) {
      console.log(
        `[scanner:llm:usage] scanId=${scanId} fresh=${llmBudget.freshEvaluations} ` +
          `skipped=${llmBudget.skipped} cacheHits=${llmBudget.cacheHits} ` +
          `promptTokens=${llmBudget.promptTokens} completionTokens=${llmBudget.completionTokens} ` +
          `estimatedCostUsd=${llmBudget.estimatedCostUsd.toFixed(6)} latencyMs=${llmBudget.latencyMs}`
      );
    }

    // Report opportunity telemetry before persistence (informational,
    // not tied to persistence outcome). Each call is isolated so one
    // failure does not suppress subsequent opportunities.
    for (const { opportunity } of opportunities) {
      try {
        this.dependencies.telemetryReporter?.reportOpportunity({
          equivalenceClass: opportunity.equivalenceClass,
          netEdge: opportunity.netEdge,
          grossEdge: opportunity.grossEdge,
          executableSizeUsd: opportunity.executableSizeUsd,
          fillRisk: opportunity.fillRisk,
          liquidityRisk: opportunity.liquidityRisk,
          dataStalenessMs: opportunity.dataStalenessMs
        });
      } catch { /* telemetry isolation */ }
    }

    try {
      const completedResult = await this.dependencies.repository.saveCompletedScan({
        scanRun: result,
        completeScanRun: (scanRun) => ({ ...scanRun, completedAt: now() }),
        snapshots,
        normalizedMarkets: normalizedMarketReviews,
        candidatePairs: reviewedCandidatePairs,
        orderbookSnapshots,
        opportunities,
        paperTradeSimulations: this.simulateOpportunities(opportunities)
      });
      // Only emit success scan metrics AFTER persistence succeeds, so
      // the same scan is never counted as both succeeded and failed.
      try {
        this.dependencies.telemetryReporter?.reportScanMetrics({
          status: result.status,
          marketsScanned: result.metrics.marketsScanned,
          normalizedMarkets: result.metrics.normalizedMarkets,
          candidatePairs: result.metrics.candidatePairs,
          opportunitiesFound: result.metrics.opportunitiesFound,
          llmEvaluations: result.metrics.llmEvaluations,
          durationMs: new Date(now()).getTime() - new Date(startedAt).getTime()
        });
      } catch { /* telemetry isolation */ }
      return completedResult;
    } catch (_error) {
      const failed = failedScanResult(scanId, startedAt, now(), result.metrics, "persistence", _error);
      await saveFailedScanRun(this.dependencies.repository, failed);
      try {
        this.dependencies.telemetryReporter?.reportScanMetrics({
          status: "failed",
          marketsScanned: result.metrics.marketsScanned,
          normalizedMarkets: result.metrics.normalizedMarkets,
          candidatePairs: result.metrics.candidatePairs,
          opportunitiesFound: result.metrics.opportunitiesFound,
          llmEvaluations: result.metrics.llmEvaluations,
          durationMs: new Date(now()).getTime() - new Date(startedAt).getTime()
        });
      } catch { /* telemetry isolation */ }
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

    // Try a cache lookup first. A cached result is budget-free for both the
    // global cap and the per-task cap, so an exhausted fresh-work budget
    // must not block a zero-cost cache hit.
    let record: LlmEvaluationRecord;
    try {
      const cached = await this.dependencies.llmGateway.findCached?.(request);
      if (cached && cached.status === "succeeded") {
        record = { ...cached, isCacheHit: true };
        budget.cacheHits += 1;
        return record;
      }
    } catch {
      // A failing cache lookup must not abort the fresh-evaluation path.
    }

    // Per-task split: keep market_normalization and market_equivalence
    // budgets independent so one family cannot starve the other.
    if (request.taskType === "market_normalization") {
      if (budget.normalizationEvaluations >= budget.maxNormalizationEvaluations) {
        budget.normalizationSkipped += 1;
        budget.skipped += 1;
        return undefined;
      }
    } else if (request.taskType === "market_equivalence") {
      if (budget.equivalenceEvaluations >= budget.maxEquivalenceEvaluations) {
        budget.equivalenceSkipped += 1;
        budget.skipped += 1;
        return undefined;
      }
    }

    if (budget.evaluations >= budget.maxEvaluations) {
      budget.skipped += 1;
      if (request.taskType === "market_normalization") budget.normalizationSkipped += 1;
      if (request.taskType === "market_equivalence") budget.equivalenceSkipped += 1;
      return undefined;
    }

    // Isolate gateway exceptions (issue #11). Optional LLM review must never
    // fail the whole scan processing path; treat any thrown error as a
    // "no review available" outcome and continue with the deterministic
    // decision.
    try {
      record = await this.dependencies.llmGateway.evaluate(request);
    } catch (error) {
      console.warn(
        `[scanner:llm:fallback] ${request.taskType} failed for model=${request.model}: ${sanitizeProviderErrorMessage(error)}`
      );
      record = {
        ...request,
        id: randomUUID(),
        inputHash: "scanner-isolated-failure",
        output: { error: sanitizeProviderErrorMessage(error) },
        parsedOutput: undefined,
        status: "failed",
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        latencyMs: 0,
        createdAt: new Date().toISOString()
      };
    }

    if (record.isCacheHit) {
      budget.cacheHits += 1;
      return record;
    }

    budget.evaluations += 1;
    if (request.taskType === "market_normalization") budget.normalizationEvaluations += 1;
    if (request.taskType === "market_equivalence") budget.equivalenceEvaluations += 1;
    budget.freshEvaluations += 1;
    budget.promptTokens += record.promptTokens;
    budget.completionTokens += record.completionTokens;
    budget.estimatedCostUsd += record.estimatedCostUsd;
    budget.latencyMs += record.latencyMs;
    return record;
  }

  // Phase 3 #6: invoke the optional paper-trade simulator for each
  // emitted opportunity. A throw from the simulator is isolated per
  // opportunity so one bad record cannot drop the rest of the scan's
  // sims or fail the scan itself. Returns an empty list when the
  // simulator dependency is not wired (the default).
  private simulateOpportunities(opportunities: readonly OpportunityWithSourceSnapshots[]): PaperTradeSimulation[] {
    const simulator = this.dependencies.paperTradeSimulator;
    if (!simulator) return [];
    const sims: PaperTradeSimulation[] = [];
    for (const { opportunity } of opportunities) {
      try {
        for (const sim of simulator.simulate(opportunity)) {
          sims.push(sim);
        }
      } catch (_error) {
        // Defensive: a malformed opportunity should never fail the
        // scan. The simulator contract is to degrade to a partial-fill
        // record, so reaching this catch indicates a bug in the
        // simulator; we drop the sims for this opportunity and continue.
      }
    }
    return sims;
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
  const totalCap = dependencies.llmGateway ? dependencies.scannerLlmMaxEvaluationsPerScan ?? 25 : 0;
  const equivalenceReserve = totalCap > 1 ? Math.min(5, Math.max(1, Math.ceil(totalCap * 0.2))) : totalCap;
  return {
    maxEvaluations: totalCap,
    evaluations: 0,
    skipped: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
    cacheHits: 0,
    freshEvaluations: 0,
    normalizationEvaluations: 0,
    equivalenceEvaluations: 0,
    maxNormalizationEvaluations: totalCap <= 1 ? totalCap : totalCap - equivalenceReserve,
    maxEquivalenceEvaluations: totalCap <= 1 ? totalCap : equivalenceReserve,
    normalizationSkipped: 0,
    equivalenceSkipped: 0
  };
}

function llmMetrics(budget: LlmScanBudget): Pick<ScanMetrics, "llmEvaluations" | "llmEvaluationsSkipped" | "llmPromptTokens" | "llmCompletionTokens" | "llmEstimatedCostUsd" | "llmLatencyMs"> {
  // Issue #6: `llmEvaluations` reports FRESH evaluations only, so
  // cached rows do not inflate the per-scan total. The raw
  // `budget.evaluations` counter (cache + fresh) is kept internally
  // for observability but is not surfaced in scan metrics.
  return {
    llmEvaluations: budget.freshEvaluations,
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
  const merge = conservativeNormalizationMerge(market, normalized);
  const merged: NormalizedMarket = {
    ...market,
    topic: merge.topic.value,
    eventType: merge.eventType.value,
    // Issue #3: preserve deterministic value when the LLM did not produce one
    // (null) so candidate generation is robust to partial LLM responses.
    asset: merge.asset.value,
    threshold: merge.threshold.value,
    operator: merge.operator.value,
    deadline: merge.deadline.value,
    timezone: merge.timezone.value,
    resolutionSource: merge.resolutionSource.value,
    payoffType: merge.payoffType.value,
    // Issue #2: do not blanket-add `llm_normalized` because
    // DeterministicEquivalencePolicy would downgrade every LLM-resolved pair
    // to class B. Only surface residual flags that the LLM explicitly
    // enumerated and field-specific material-flip rejection notes.
    ambiguityFlags: uniqueStrings([
      ...normalized.ambiguityFlags,
      ...merge.rejectionFlags
    ]),
    confidence: normalized.confidence
  };

  return { market: merged, llmEvaluation };
}

interface LlmNormalizationOutput {
  topic: Topic;
  eventType: EventType;
  asset: string | null;
  threshold: number | null;
  operator: MarketOperator | null;
  deadline: string | null;
  timezone: string | null;
  resolutionSource: string | null;
  payoffType: PayoffType;
  confidence: number;
  ambiguityFlags: string[];
}

function conservativeNormalizationMerge(market: NormalizedMarket, normalized: LlmNormalizationOutput): {
  topic: MergeResult<Topic>;
  eventType: MergeResult<EventType>;
  asset: MergeResult<string | undefined>;
  threshold: MergeResult<number | undefined>;
  operator: MergeResult<MarketOperator | undefined>;
  deadline: MergeResult<string | undefined>;
  timezone: MergeResult<string | undefined>;
  resolutionSource: MergeResult<string | undefined>;
  payoffType: MergeResult<PayoffType>;
  rejectionFlags: string[];
} {
  const topic = mergeExactField("topic", market.topic, normalized.topic);
  const eventType = mergeExactField("event_type", market.eventType, normalized.eventType);
  const asset = mergeNullableExactField("asset", market.asset, normalized.asset);
  const threshold = mergeNullableField("threshold", market.threshold, normalized.threshold, thresholdsEquivalent);
  const operator = mergeNullableExactField("operator", market.operator, normalized.operator);
  const deadline = mergeNullableField("deadline", market.deadline, normalized.deadline, deadlinesEquivalent);
  const timezone = mergeNullableExactField("timezone", market.timezone, normalized.timezone);
  // resolutionSource is a class-A/B decision input: only accept the LLM
  // value when the deterministic prior was missing or they match. Any
  // override must surface a rejection flag so the equivalence policy can
  // keep the pair advisory instead of class A.
  const resolutionSource = mergeNullableExactField("resolution_source", market.resolutionSource, normalized.resolutionSource);
  const payoffType = mergeExactField("payoff_type", market.payoffType, normalized.payoffType);
  return {
    topic,
    eventType,
    asset,
    threshold,
    operator,
    deadline,
    timezone,
    resolutionSource,
    payoffType,
    rejectionFlags: [topic, eventType, asset, threshold, operator, deadline, timezone, resolutionSource, payoffType].flatMap((result) => result.rejectionFlag ? [result.rejectionFlag] : [])
  };
}

interface MergeResult<T> {
  value: T;
  rejectionFlag?: string;
}

function mergeExactField<T>(field: string, deterministic: T, llmValue: T): MergeResult<T> {
  if (deterministic === undefined || deterministic === null || deterministic === llmValue) {
    return { value: llmValue };
  }
  return { value: deterministic, rejectionFlag: `llm_${field}_flip_rejected` };
}

function mergeNullableExactField<T>(field: string, deterministic: T | undefined, llmValue: T | null): MergeResult<T | undefined> {
  return mergeNullableField(field, deterministic, llmValue, (left, right) => left === right);
}

function mergeNullableField<T>(
  field: string,
  deterministic: T | undefined,
  llmValue: T | null,
  equivalent: (left: T, right: T) => boolean
): MergeResult<T | undefined> {
  if (llmValue === null) return { value: deterministic };
  if (deterministic === undefined || equivalent(deterministic, llmValue)) return { value: llmValue };
  return { value: deterministic, rejectionFlag: `llm_${field}_flip_rejected` };
}

function thresholdsEquivalent(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000001;
}

function deadlinesEquivalent(left: string, right: string): boolean {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  return Math.abs(leftTime - rightTime) <= 60 * 1000;
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
    // Issue #1: LLM-confirmed equivalence on a deterministic B/D pair must be
    // mapped into the decision. Conservative promotion: only when the LLM
    // clears a high threshold (>=0.7) AND the deterministic prior did not
    // already reject on a hard material mismatch. We reclassify the
    // equivalence class (D -> B -> A only when class is alert-only/human-review
    // on a non-reject path) so a successful LLM verdict can produce a
    // tradable class A when the prior was B with only soft reasons, and a
    // tradable class A on a B-prior with no hard reasons.
    const promotedClass = promoteEquivalenceClass(decision, verdict.confidence);
    const promotedDecision = promoteEquivalenceDecision(decision, promotedClass);
    return {
      ...decision,
      equivalenceClass: promotedClass,
      decision: promotedDecision,
      reasons: [...decision.reasons, "llm_supported_equivalence"]
    };
  }

  return { ...decision, reasons: [...decision.reasons, "llm_inconclusive"] };
}

function promoteEquivalenceClass(decision: EquivalenceDecision, confidence: number): EquivalenceDecision["equivalenceClass"] {
  // Issue #1 / class-A promotion guard: the LLM can only promote a
  // deterministic class-B pair to class A when BOTH of the following hold:
  //   1. The deterministic decision is class B (alert-only) — never C/D.
  //   2. Every reason on the decision is in the explicit soft-reason
  //      allowlist. A hand-maintained denylist of hard reasons is fragile
  //      when the policy grows new reasons; an allowlist is the safe
  //      default. Pair-level reasons that did not come from
  //      DeterministicEquivalencePolicy are conservatively treated as
  //      hard until they are explicitly allowed.
  // D-class pairs (low_normalization_confidence) are downgraded to B when
  // the LLM clears the human-review need, but cannot reach A.
  if (confidence < 0.7) return decision.equivalenceClass;
  if (decision.equivalenceClass === "D") return "B";
  if (decision.equivalenceClass !== "B") return decision.equivalenceClass;
  if (confidence < 0.9) return "B";
  const allReasonsSoft = decision.reasons.every((reason) => SOFT_REVIEW_REASONS.has(reason));
  return allReasonsSoft ? "A" : "B";
}

function promoteEquivalenceDecision(decision: EquivalenceDecision, promotedClass: EquivalenceDecision["equivalenceClass"]): EquivalenceDecision["decision"] {
  if (promotedClass === "A") return "tradable";
  if (promotedClass === "B") return decision.decision === "tradable" ? "tradable" : "alert_only";
  if (promotedClass === "C") return "reject";
  return decision.decision;
}

const SOFT_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "ambiguity_flags_present",
  "resolution_source_missing",
  "resolution_source_differs",
  "llm_inconclusive",
  "llm_supported_equivalence",
  "deterministic_fields_match"
]);

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

function sanitizeProviderErrorMessage(error: unknown): string {
  return sanitizeFailureReason(error);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
