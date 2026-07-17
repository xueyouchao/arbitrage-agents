// Issue #96: PMXT-read downstream opportunity parity.
//
// Runs PMXT-derived markets and books through the existing production
// normalizer, candidate generator, deterministic/LLM equivalence policy,
// calculator, fee resolver, and risk classifier with frozen identical
// options. Persists shadow-only candidates, opportunities, and reason-coded
// comparisons. Every shadow output is isolated from production notification,
// execution, positions, and production opportunity APIs.
//
// Key behaviors:
//   - Canonical adapter maps PMXT catalog identity to native venue identity
//     while preserving PMXT provenance separately.
//   - Both paths receive the exact same resolved, recursively-frozen
//     calculator options object.
//   - Provider fee metadata is compared separately and never influences
//     canonical parity unless both paths expose verified equivalent metadata.
//   - Shadow LLM review uses the same prompt construction and validators
//     with a distinct prompt-version namespace, so it cannot overwrite
//     production cache provenance.
//   - Every discrepancy is assigned an explicit cause and includes full
//     input/provider/timestamp/config provenance.

import { CrossVenueOpportunity } from "../../arbitrage/domain/opportunity";
import {
  OpportunityCalculator,
  OpportunityCalculatorOptions,
} from "../../arbitrage/domain/opportunity-calculator";
import {
  LlmEvaluationRecord,
  LlmEvaluationRequest,
} from "../../llm/application/llm-evaluation";
import {
  CandidatePair,
  EquivalenceDecision,
} from "../../matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../../matching/domain/candidate-pair-generator";
import {
  DeterministicEquivalencePolicy,
} from "../../matching/domain/equivalence-policy";
import { MarketNormalizer } from "../../matching/domain/market-normalizer";
import { NormalizedMarket, Venue } from "../../matching/domain/normalized-market";
import { MarketBook } from "../../arbitrage/domain/opportunity";
import { PmxtMarketBook } from "../../venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import { PmxtMarketSnapshot } from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class PmxtReadParityError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PmxtReadParityError";
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface PmxtReadParityProvenance {
  input: {
    authoritativeScanRunId: string;
    shadowRunId: string;
    shadowRunAttemptId: string;
    authoritativeMarketIds: string[];
    pmxtCatalogMarketIds: string[];
    pmxtOutcomeIds: string[];
  };
  provider: {
    authoritative: string;
    shadow: string;
    sourceExchanges: string[];
    llmModel: string;
  };
  timestamps: {
    authoritativeCapturedAt: string;
    shadowCapturedAt: string;
    comparedAt: string;
  };
  config: {
    productionPromptVersion: string;
    shadowPromptVersion: string;
    calculatorOptions: Readonly<OpportunityCalculatorOptions>;
  };
}

// ---------------------------------------------------------------------------
// Comparison types
// ---------------------------------------------------------------------------

export type ParityStage =
  | "normalization"
  | "pairing"
  | "deterministic_equivalence"
  | "llm_equivalence"
  | "fees"
  | "calculation"
  | "depth"
  | "executable_size"
  | "risk";

export type ParityOutcome = "match" | "discrepancy" | "excluded";

export interface FeeComparisonAuthoritative {
  feeSource: string;
  providerMetadata: unknown;
}

export interface FeeComparisonShadow {
  feeSource: string;
  providerMetadata: unknown;
  metadataOutcome: "identical" | "different" | "missing_peer" | "unverified";
  metadataCause: string;
  verifiedProviderMetadataUsed: boolean;
}

export interface PmxtReadParityComparison {
  stage: ParityStage;
  outcome: ParityOutcome;
  cause: string;
  authoritative: unknown;
  shadow: unknown;
  provenance: PmxtReadParityProvenance;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface PmxtReadParityResult {
  authoritative: {
    normalizedMarkets: NormalizedMarket[];
    candidatePairs: CandidatePair[];
    deterministicDecisions: EquivalenceDecision[];
    llmEvaluations: LlmEvaluationRecord[];
    opportunities: CrossVenueOpportunity[];
  };
  shadow: {
    canonicalMarkets: VenueMarketSnapshot[];
    canonicalBooks: MarketBook[];
    normalizedMarkets: NormalizedMarket[];
    candidatePairs: CandidatePair[];
    deterministicDecisions: EquivalenceDecision[];
    llmEvaluations: LlmEvaluationRecord[];
    opportunities: CrossVenueOpportunity[];
  };
  comparisons: PmxtReadParityComparison[];
}

// ---------------------------------------------------------------------------
// Batch (persistence DTO)
// ---------------------------------------------------------------------------

export interface PmxtReadParityBatch {
  authoritativeScanRunId: string;
  shadowRunId: string;
  shadowRunAttemptId: string;
  candidates: CandidatePair[];
  opportunities: CrossVenueOpportunity[];
  comparisons: PmxtReadParityComparison[];
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

export interface PmxtReadParityRepository {
  saveBatch(batch: PmxtReadParityBatch): Promise<void>;
}

// ---------------------------------------------------------------------------
// Calculator options resolver
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: OpportunityCalculatorOptions = {
  feeRate: 0.01,
  slippageRate: 0.005,
  now: "",
  maxBookAgeMs: 60_000,
  minNetEdge: 0,
  profitabilityBuffer: 0,
  targetNotionalsUsd: [5, 25, 100],
  venueFeeRates: {
    kalshi: { YES: 0.01, NO: 0.01 },
    polymarket: { YES: 0.01, NO: 0.01 },
  },
  venueSlippageRates: {
    kalshi: { YES: 0.005, NO: 0.005 },
    polymarket: { YES: 0.005, NO: 0.005 },
  },
  feeModels: {},
  feeSource: "config",
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1",
};

type SideRates = Partial<Record<"YES" | "NO", number>>;
type VenueFeeRates = Partial<Record<Venue, SideRates>>;
type VenueSlippageRates = Partial<Record<Venue, SideRates>>;

const KNOWN_VENUES: readonly Venue[] = ["kalshi", "polymarket"];

function defaultVenueRates(rate: number): VenueFeeRates {
  return Object.fromEntries(
    KNOWN_VENUES.map((v) => [v, { YES: rate, NO: rate }]),
  ) as VenueFeeRates;
}

function mergeVenueRates(
  defaults: VenueFeeRates,
  overrides?: VenueFeeRates,
): VenueFeeRates {
  return Object.fromEntries(
    KNOWN_VENUES.map((v) => [v, { ...defaults[v], ...overrides?.[v] }]),
  ) as VenueFeeRates;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function resolveOpportunityCalculatorOptions(
  partial: Partial<OpportunityCalculatorOptions>,
): Readonly<OpportunityCalculatorOptions> {
  const targetNotionalsUsd = [
    ...new Set(partial.targetNotionalsUsd ?? DEFAULT_OPTIONS.targetNotionalsUsd),
  ]
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  const resolved: OpportunityCalculatorOptions = {
    ...DEFAULT_OPTIONS,
    ...partial,
    venueFeeRates: mergeVenueRates(
      defaultVenueRates(partial.feeRate ?? DEFAULT_OPTIONS.feeRate),
      partial.venueFeeRates,
    ),
    venueSlippageRates: mergeVenueRates(
      defaultVenueRates(partial.slippageRate ?? DEFAULT_OPTIONS.slippageRate),
      partial.venueSlippageRates,
    ),
    feeModels: partial.feeModels ?? {},
    targetNotionalsUsd:
      targetNotionalsUsd.length > 0
        ? targetNotionalsUsd
        : DEFAULT_OPTIONS.targetNotionalsUsd,
  };

  return deepFreeze(resolved);
}

// ---------------------------------------------------------------------------
// LLM request builder
// ---------------------------------------------------------------------------

export function buildPmxtShadowLlmRequest(
  productionRequest: LlmEvaluationRequest,
): LlmEvaluationRequest {
  return {
    ...productionRequest,
    promptVersion: `pmxt-shadow/${productionRequest.promptVersion}`,
    // Keep the exact same input object reference so the input hash is
    // identical. The cache unique key is (taskType, inputHash,
    // promptVersion, model), so the shadow namespace prevents any
    // collision with the production cache row.
    input: productionRequest.input,
  };
}

// ---------------------------------------------------------------------------
// Canonical PMXT adapter
// ---------------------------------------------------------------------------

interface PmxtProvenance {
  catalogMarketId: string;
  sourceExchange: string;
  venueMarketId: string;
  yesOutcomeId?: string;
  noOutcomeId?: string;
}

function extractPmxtProvenance(
  pmxt: PmxtMarketSnapshot,
): { venue: Venue; venueMarketId: string; provenance: PmxtProvenance } {
  const payload = pmxt.rawPayload;

  const sourceExchange =
    typeof payload.sourceExchange === "string"
      ? payload.sourceExchange.trim().toLowerCase()
      : undefined;

  if (!sourceExchange) {
    throw new PmxtReadParityError(
      "missing_source_exchange",
      `PMXT market ${pmxt.venueMarketId} has no sourceExchange in rawPayload`,
    );
  }

  let venue: Venue;
  if (sourceExchange === "kalshi") venue = "kalshi";
  else if (sourceExchange === "polymarket") venue = "polymarket";
  else
    throw new PmxtReadParityError(
      "ambiguous_source_exchange",
      `PMXT market ${pmxt.venueMarketId} has unrecognized sourceExchange "${sourceExchange}"`,
    );

  const rawVenueMarketId = payload.venueMarketId;

  // Reject ambiguous identity — an array means the PMXT record maps to
  // multiple native markets and cannot be used for parity.
  if (Array.isArray(rawVenueMarketId)) {
    throw new PmxtReadParityError(
      "ambiguous_market_identity",
      `PMXT market ${pmxt.venueMarketId} has an array venueMarketId`,
    );
  }

  const venueMarketId =
    typeof rawVenueMarketId === "string"
      ? rawVenueMarketId.trim()
      : undefined;
  if (!venueMarketId) {
    throw new PmxtReadParityError(
      "missing_venue_market_id",
      `PMXT market ${pmxt.venueMarketId} has no venueMarketId in rawPayload`,
    );
  }

  const provenance: PmxtProvenance = {
    catalogMarketId: pmxt.venueMarketId,
    sourceExchange,
    venueMarketId,
    yesOutcomeId:
      typeof payload.yesOutcomeId === "string"
        ? payload.yesOutcomeId
        : undefined,
    noOutcomeId:
      typeof payload.noOutcomeId === "string"
        ? payload.noOutcomeId
        : undefined,
  };

  return { venue, venueMarketId, provenance };
}

export function canonicalizePmxtMarketSnapshot(
  pmxt: PmxtMarketSnapshot,
): VenueMarketSnapshot {
  const { venue, venueMarketId, provenance } = extractPmxtProvenance(pmxt);
  // The canonical snapshot's rawPayload mirrors what the native venue
  // client would have produced. PMXT-specific fields (sourceExchange,
  // outcome IDs, catalogMarketId) are preserved only in pmxtProvenance.
  const sourcePayload =
    (pmxt.rawPayload.sourcePayload as Record<string, unknown> | undefined) ??
    {};
  return {
    venue,
    venueMarketId,
    title: pmxt.title,
    rawResolutionText: pmxt.rawResolutionText,
    capturedAt: pmxt.capturedAt,
    rawPayload: {
      ...sourcePayload,
      pmxtProvenance: provenance,
    },
  };
}

export function canonicalizePmxtMarketBook(
  pmxtMarket: PmxtMarketSnapshot,
  pmxtBook: PmxtMarketBook,
): MarketBook {
  const { venue, venueMarketId, provenance } =
    extractPmxtProvenance(pmxtMarket);

  // Reject one-sided books — never synthesize a missing ask from the
  // other side or from bids.
  const hasYes =
    pmxtBook.yesAsk !== undefined &&
    Number.isFinite(pmxtBook.yesAsk) &&
    pmxtBook.yesAsk > 0 &&
    pmxtBook.yesAsk < 1 &&
    pmxtBook.yesAvailableUsd > 0;
  const hasNo =
    pmxtBook.noAsk !== undefined &&
    Number.isFinite(pmxtBook.noAsk) &&
    pmxtBook.noAsk > 0 &&
    pmxtBook.noAsk < 1 &&
    pmxtBook.noAvailableUsd > 0;

  if (!hasYes || !hasNo) {
    throw new PmxtReadParityError(
      "one_sided_book",
      `PMXT book for market ${pmxtMarket.venueMarketId} is one-sided (yesAsk=${pmxtBook.yesAsk}, noAsk=${pmxtBook.noAsk})`,
    );
  }

  return {
    marketId: venueMarketId,
    venue,
    yesAsk: pmxtBook.yesAsk!,
    noAsk: pmxtBook.noAsk!,
    yesAvailableUsd: pmxtBook.yesAvailableUsd,
    noAvailableUsd: pmxtBook.noAvailableUsd,
    yesDepth: pmxtBook.yesDepth,
    noDepth: pmxtBook.noDepth,
    capturedAt: pmxtBook.capturedAt,
    stale: pmxtBook.stale,
    rawPayload: {
      ...((pmxtBook.rawPayload.sourcePayload as Record<string, unknown> | undefined) ?? {}),
      feeSchedule: pmxtBook.rawPayload.feeSchedule,
      pmxtProvenance: provenance,
    },
  };
}

// ---------------------------------------------------------------------------
// Fee metadata comparison
// ---------------------------------------------------------------------------

interface FeeComparisonResult {
  authoritative: FeeComparisonAuthoritative;
  shadow: FeeComparisonShadow;
  outcome: ParityOutcome;
  cause: string;
}

function extractProviderFeeMetadata(
  book: MarketBook,
): unknown {
  const raw = book.rawPayload;
  if (!raw) return null;
  // Polymarket fee schedule is the only known provider metadata path.
  // Return the full { feeSchedule: ... } wrapper so the comparison record
  // preserves which metadata field was observed.
  const feeSchedule = raw.feeSchedule;
  if (feeSchedule !== undefined) return { feeSchedule };
  return null;
}

function compareFeeMetadata(
  authKalshiBook: MarketBook | undefined,
  authPolymarketBook: MarketBook | undefined,
  shadowKalshiBook: MarketBook | undefined,
  shadowPolymarketBook: MarketBook | undefined,
  feeSource: string,
): FeeComparisonResult {
  // Both paths use the same resolved feeSource ("config" by default).
  // Provider fee metadata is compared separately.
  const authPolyMetadata = authPolymarketBook
    ? extractProviderFeeMetadata(authPolymarketBook)
    : null;
  const shadowPolyMetadata = shadowPolymarketBook
    ? extractProviderFeeMetadata(shadowPolymarketBook)
    : null;

  let metadataOutcome: FeeComparisonShadow["metadataOutcome"];
  let metadataCause: string;
  let verifiedProviderMetadataUsed = false;

  // When feeSource is "config", provider fee metadata is observed but not
  // applied. Any non-null provider metadata is treated as "different"
  // (unverified) because it has not been verified against a peer.
  if (feeSource === "config") {
    if (authPolyMetadata === null && shadowPolyMetadata === null) {
      metadataOutcome = "identical";
      metadataCause = "no_provider_fee_metadata";
    } else {
      metadataOutcome = "different";
      metadataCause = "unverified_provider_fee_metadata";
    }
  } else if (authPolyMetadata === null && shadowPolyMetadata === null) {
    metadataOutcome = "identical";
    metadataCause = "no_provider_fee_metadata";
  } else if (authPolyMetadata === null || shadowPolyMetadata === null) {
    metadataOutcome = "missing_peer";
    metadataCause = "provider_fee_metadata_missing_on_one_side";
  } else if (JSON.stringify(authPolyMetadata) === JSON.stringify(shadowPolyMetadata)) {
    metadataOutcome = "identical";
    metadataCause = "provider_fee_metadata_identical";
    verifiedProviderMetadataUsed = true;
  } else {
    metadataOutcome = "different";
    metadataCause = "unverified_provider_fee_metadata";
  }

  return {
    authoritative: { feeSource, providerMetadata: authPolyMetadata },
    shadow: {
      feeSource,
      providerMetadata: shadowPolyMetadata,
      metadataOutcome,
      metadataCause,
      verifiedProviderMetadataUsed,
    },
    outcome: "match",
    cause:
      feeSource === "config"
        ? "configured_fees_identical_unverified_metadata_ignored"
        : metadataOutcome === "identical"
          ? "verified_provider_fee_metadata_identical"
          : "provider_fee_metadata_mismatch",
  };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function matchComparison(
  stage: ParityStage,
  provenance: PmxtReadParityProvenance,
  authoritative: unknown,
  shadow: unknown,
  cause = "identical",
): PmxtReadParityComparison {
  return {
    stage,
    outcome: "match",
    cause,
    authoritative,
    shadow,
    provenance,
  };
}

function discrepancyComparison(
  stage: ParityStage,
  provenance: PmxtReadParityProvenance,
  authoritative: unknown,
  shadow: unknown,
  cause: string,
): PmxtReadParityComparison {
  return {
    stage,
    outcome: "discrepancy",
    cause,
    authoritative,
    shadow,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Pipeline dependencies
// ---------------------------------------------------------------------------

export interface PmxtReadParityPipelineDeps {
  normalizer: MarketNormalizer;
  pairGenerator: CandidatePairGenerator;
  equivalencePolicy: DeterministicEquivalencePolicy;
  opportunityCalculator: OpportunityCalculator;
  llmGateway: {
    evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord>;
  };
  buildProductionLlmRequest: (
    pair: CandidatePair,
    decision: EquivalenceDecision,
  ) => LlmEvaluationRequest;
  repository: PmxtReadParityRepository;
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface PmxtReadParityInput {
  authoritative: {
    markets: VenueMarketSnapshot[];
    books: MarketBook[];
  };
  pmxt: {
    markets: PmxtMarketSnapshot[];
    books: PmxtMarketBook[];
  };
  calculatorOptions: Readonly<OpportunityCalculatorOptions>;
  provenance: PmxtReadParityProvenance;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class PmxtReadParityPipeline {
  constructor(private readonly deps: PmxtReadParityPipelineDeps) {}

  async run(input: PmxtReadParityInput): Promise<PmxtReadParityResult> {
    const { calculatorOptions, provenance } = input;

    // --- Canonicalize PMXT inputs ---
    const shadowCanonicalMarkets = input.pmxt.markets.map(
      canonicalizePmxtMarketSnapshot,
    );

    // Build a lookup from PMXT catalog ID to its canonical snapshot, so
    // each book can be joined back to the correct market record.
    const pmxtMarketByCatalogId = new Map(
      input.pmxt.markets.map((m) => [m.venueMarketId, m]),
    );
    const shadowCanonicalBooks = input.pmxt.books.map((book) => {
      const market = pmxtMarketByCatalogId.get(book.marketId);
      if (!market) {
        throw new PmxtReadParityError(
          "missing_pmxt_market_for_book",
          `PMXT book references unknown market ${book.marketId}`,
        );
      }
      return canonicalizePmxtMarketBook(market, book);
    });

    // --- Normalization ---
    const authNormalized = input.authoritative.markets.map((s) =>
      this.deps.normalizer.normalize(s),
    );
    const shadowNormalized = shadowCanonicalMarkets.map((s) =>
      this.deps.normalizer.normalize(s),
    );

    const normalizationComparison = this.compareStage(
      "normalization",
      authNormalized,
      shadowNormalized,
      provenance,
      "normalization_output_differs",
    );

    // --- Candidate generation ---
    const authPairs = this.deps.pairGenerator.generate(authNormalized);
    const shadowPairs = this.deps.pairGenerator.generate(shadowNormalized);

    const pairingComparison = this.compareStage(
      "pairing",
      authPairs,
      shadowPairs,
      provenance,
      "candidate_pair_set_differs",
    );

    // --- Deterministic equivalence ---
    const authDecisions = authPairs.map((p) =>
      this.deps.equivalencePolicy.classify(p),
    );
    const shadowDecisions = shadowPairs.map((p) =>
      this.deps.equivalencePolicy.classify(p),
    );

    const deterministicComparison = this.compareStage(
      "deterministic_equivalence",
      authDecisions,
      shadowDecisions,
      provenance,
      "deterministic_decision_differs",
    );

    // --- LLM equivalence ---
    const authLlm = await this.runLlmReview(authPairs, authDecisions, false);
    const shadowLlm = await this.runLlmReview(shadowPairs, shadowDecisions, true);

    const llmComparison = this.compareStage(
      "llm_equivalence",
      authLlm.map((r) => r.parsedOutput),
      shadowLlm.map((r) => r.parsedOutput),
      provenance,
      "llm_review_output_differs",
    );

    // --- Fee metadata comparison ---
    const authBookByKey = new Map(
      input.authoritative.books.map((b) => [`${b.venue}:${b.marketId}`, b]),
    );
    const shadowBookByKey = new Map(
      shadowCanonicalBooks.map((b) => [`${b.venue}:${b.marketId}`, b]),
    );

    // Find the first pair that produces an opportunity to compare fees
    // and calculations. If no pairs exist, use placeholder books.
    const firstPair = authPairs[0] ?? shadowPairs[0];
    let authKalshiBook: MarketBook | undefined;
    let authPolymarketBook: MarketBook | undefined;
    let shadowKalshiBook: MarketBook | undefined;
    let shadowPolymarketBook: MarketBook | undefined;

    if (firstPair) {
      authKalshiBook = authBookByKey.get(
        `${firstPair.kalshiMarket.venue}:${firstPair.kalshiMarket.venueMarketId}`,
      );
      authPolymarketBook = authBookByKey.get(
        `${firstPair.polymarketMarket.venue}:${firstPair.polymarketMarket.venueMarketId}`,
      );
      shadowKalshiBook = shadowBookByKey.get(
        `${firstPair.kalshiMarket.venue}:${firstPair.kalshiMarket.venueMarketId}`,
      );
      shadowPolymarketBook = shadowBookByKey.get(
        `${firstPair.polymarketMarket.venue}:${firstPair.polymarketMarket.venueMarketId}`,
      );
    }

    const feeResult = compareFeeMetadata(
      authKalshiBook,
      authPolymarketBook,
      shadowKalshiBook,
      shadowPolymarketBook,
      calculatorOptions.feeSource,
    );

    const feeComparison: PmxtReadParityComparison = {
      stage: "fees",
      outcome: feeResult.outcome,
      cause: feeResult.cause,
      authoritative: feeResult.authoritative,
      shadow: feeResult.shadow,
      provenance,
    };

    // --- Calculation ---
    const authOpportunities = this.calculateOpportunities(
      authPairs,
      authDecisions,
      input.authoritative.books,
      calculatorOptions,
    );
    const shadowOpportunities = this.calculateOpportunities(
      shadowPairs,
      shadowDecisions,
      shadowCanonicalBooks,
      calculatorOptions,
    );

    const calculationComparison = this.compareStage(
      "calculation",
      authOpportunities.map((o) => ({
        combinedCost: o.combinedCost,
        grossEdge: o.grossEdge,
        estimatedFees: o.estimatedFees,
        estimatedSlippage: o.estimatedSlippage,
        netEdge: o.netEdge,
      })),
      shadowOpportunities.map((o) => ({
        combinedCost: o.combinedCost,
        grossEdge: o.grossEdge,
        estimatedFees: o.estimatedFees,
        estimatedSlippage: o.estimatedSlippage,
        netEdge: o.netEdge,
      })),
      provenance,
      "calculation_output_differs",
    );

    // --- Depth ---
    const depthComparison = this.compareStage(
      "depth",
      authOpportunities.map((o) => o.notionalEdges),
      shadowOpportunities.map((o) => o.notionalEdges),
      provenance,
      "depth_output_differs",
    );

    // --- Executable size ---
    const executableSizeComparison = this.compareStage(
      "executable_size",
      authOpportunities.map((o) => o.executableSizeUsd),
      shadowOpportunities.map((o) => o.executableSizeUsd),
      provenance,
      "executable_size_output_differs",
    );

    // --- Risk ---
    const riskComparison = this.compareStage(
      "risk",
      authOpportunities.map((o) => ({
        resolutionRisk: o.resolutionRisk,
        fillRisk: o.fillRisk,
        liquidityRisk: o.liquidityRisk,
        venueRisk: o.venueRisk,
        equivalenceRisk: o.equivalenceRisk,
        dataStalenessMs: o.dataStalenessMs,
        riskStructure: o.riskStructure,
      })),
      shadowOpportunities.map((o) => ({
        resolutionRisk: o.resolutionRisk,
        fillRisk: o.fillRisk,
        liquidityRisk: o.liquidityRisk,
        venueRisk: o.venueRisk,
        equivalenceRisk: o.equivalenceRisk,
        dataStalenessMs: o.dataStalenessMs,
        riskStructure: o.riskStructure,
      })),
      provenance,
      "risk_output_differs",
    );

    const comparisons: PmxtReadParityComparison[] = [
      normalizationComparison,
      pairingComparison,
      deterministicComparison,
      llmComparison,
      feeComparison,
      calculationComparison,
      depthComparison,
      executableSizeComparison,
      riskComparison,
    ];

    // --- Persist shadow-only batch ---
    const batch: PmxtReadParityBatch = {
      authoritativeScanRunId: provenance.input.authoritativeScanRunId,
      shadowRunId: provenance.input.shadowRunId,
      shadowRunAttemptId: provenance.input.shadowRunAttemptId,
      candidates: shadowPairs,
      opportunities: shadowOpportunities,
      comparisons,
    };
    await this.deps.repository.saveBatch(batch);

    return {
      authoritative: {
        normalizedMarkets: authNormalized,
        candidatePairs: authPairs,
        deterministicDecisions: authDecisions,
        llmEvaluations: authLlm,
        opportunities: authOpportunities,
      },
      shadow: {
        canonicalMarkets: shadowCanonicalMarkets,
        canonicalBooks: shadowCanonicalBooks,
        normalizedMarkets: shadowNormalized,
        candidatePairs: shadowPairs,
        deterministicDecisions: shadowDecisions,
        llmEvaluations: shadowLlm,
        opportunities: shadowOpportunities,
      },
      comparisons,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async runLlmReview(
    pairs: CandidatePair[],
    decisions: EquivalenceDecision[],
    isShadow: boolean,
  ): Promise<LlmEvaluationRecord[]> {
    const results: LlmEvaluationRecord[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const decision = decisions[i];
      const request = this.deps.buildProductionLlmRequest(pair, decision);
      const effectiveRequest = isShadow
        ? buildPmxtShadowLlmRequest(request)
        : request;
      results.push(await this.deps.llmGateway.evaluate(effectiveRequest));
    }
    return results;
  }

  private calculateOpportunities(
    pairs: CandidatePair[],
    decisions: EquivalenceDecision[],
    books: MarketBook[],
    options: Readonly<OpportunityCalculatorOptions>,
  ): CrossVenueOpportunity[] {
    const booksByKey = new Map(
      books.map((b) => [`${b.venue}:${b.marketId}`, b]),
    );
    const opportunities: CrossVenueOpportunity[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const decision = decisions[i];
      if (decision.equivalenceClass !== "A") continue;
      const kalshiKey = `${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`;
      const polyKey = `${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`;
      const kalshiBook = booksByKey.get(kalshiKey);
      const polyBook = booksByKey.get(polyKey);
      if (!kalshiBook || !polyBook) continue;
      opportunities.push(
        ...this.deps.opportunityCalculator.calculate(
          pair,
          decision,
          kalshiBook,
          polyBook,
          options,
        ),
      );
    }
    return opportunities;
  }

  private compareStage(
    stage: ParityStage,
    authoritative: unknown,
    shadow: unknown,
    provenance: PmxtReadParityProvenance,
    discrepancyCause: string,
    matchCause = "identical",
  ): PmxtReadParityComparison {
    const equal =
      JSON.stringify(authoritative) === JSON.stringify(shadow);
    return equal
      ? matchComparison(stage, provenance, authoritative, shadow, matchCause)
      : discrepancyComparison(
          stage,
          provenance,
          authoritative,
          shadow,
          discrepancyCause,
        );
  }
}
