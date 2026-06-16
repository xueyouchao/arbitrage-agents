import { randomUUID } from "crypto";
import { OpportunityCalculator } from "../arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../arbitrage/domain/opportunity";
import { PaperTradeSimulation, PaperTradeSimulator } from "../arbitrage/domain/paper-trade-simulator";
import { LlmEvaluationRecord, LlmEvaluationRequest } from "../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../matching/domain/equivalence-policy";
import { CryptoMarketNormalizer } from "../matching/domain/crypto-market-normalizer";
import { CryptoAsset, EventType, MarketOperator, NormalizedMarket, PayoffType, Topic } from "../matching/domain/normalized-market";
import { sanitizeFailureReason } from "../shared/sanitize-failure-reason";
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
  // Phase 3 #6: optional paper-trade simulator. When absent, the scan
  // emits zero sims and the scanner continues unaffected. The simulator
  // is wrapped in try/catch so a single malformed opportunity can never
  // fail the scan.
  paperTradeSimulator?: PaperTradeSimulator;
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
        opportunities,
        paperTradeSimulations: this.simulateOpportunities(opportunities)
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

function conservativeNormalizationMerge(market: NormalizedMarket, normalized: LlmNormalizationOutput): {
  topic: MergeResult<Topic>;
  eventType: MergeResult<EventType>;
  asset: MergeResult<CryptoAsset | undefined>;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
