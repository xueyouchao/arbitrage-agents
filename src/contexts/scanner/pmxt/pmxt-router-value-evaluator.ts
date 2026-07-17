// Issue #98: Evaluate PMXT Router opportunity value.
//
// Combines approved Router identity projections with verified books and the
// frozen downstream policy to measure incremental executable value versus
// legacy and PMXT-read candidates. Router output never enters production
// paths — all results are shadow-only with complete provenance.
//
// Key behaviors:
//   - Each Router candidate is independently verified: relation must be
//     "identity", a direct rawMatch edge must exist, verified markets and
//     books must be present, books must not be stale, and fees must be
//     resolvable. Any violation excludes the candidate from adoption
//     evidence.
//   - Approved candidates use the identical frozen calculator options,
//     equivalence policy, LLM shadow namespacing, fee comparison, and risk
//     classification as PMXT-read parity (Issue #96).
//   - Router-only opportunities carry complete edge, market, book, fee,
//     timestamp, and decision provenance.
//   - Incremental valid candidates and executable opportunities are
//     separated from false positives, stale-book artifacts, and fee/unit
//     mapping discrepancies.

import { CrossVenueOpportunity, MarketBook } from "../../arbitrage/domain/opportunity";
import { OpportunityCalculator, OpportunityCalculatorOptions } from "../../arbitrage/domain/opportunity-calculator";
import { LlmEvaluationRecord, LlmEvaluationRequest } from "../../llm/application/llm-evaluation";
import { CandidatePair, EquivalenceDecision } from "../../matching/domain/candidate-pair";
import { DeterministicEquivalencePolicy } from "../../matching/domain/equivalence-policy";
import { MarketNormalizer } from "../../matching/domain/market-normalizer";
import { NormalizedMarket } from "../../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { buildPmxtShadowLlmRequest } from "./pmxt-read-parity";
import {
  PmxtRouterCandidate,
  PmxtRouterProjectedEdge,
  PmxtRouterProjectionResult,
} from "./pmxt-router-match-projector";

// ---------------------------------------------------------------------------
// Exclusion and status types
// ---------------------------------------------------------------------------

export type RouterValueExclusionReason =
  | "unapproved_relation_kind"
  | "missing_direct_edge"
  | "unverified_book"
  | "ambiguous_semantics"
  | "equivalence_rejected";

export type RouterCandidateValueStatus =
  | "valid"
  | "false_positive"
  | "stale_book_artifact"
  | "fee_unit_discrepancy"
  | "excluded";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface RouterCandidateProvenance {
  edge: PmxtRouterProjectedEdge;
  kalshiMarket?: NormalizedMarket;
  polymarketMarket?: NormalizedMarket;
  kalshiBook?: MarketBook;
  polymarketBook?: MarketBook;
  feeComparison: {
    feeSource: string;
    resolved: boolean;
    discrepancy: string | null;
  };
  timestamp: {
    edgeCapturedAt: string;
    bookCapturedAt?: string;
    evaluatedAt: string;
  };
  decision?: EquivalenceDecision;
  llmEvaluation?: LlmEvaluationRecord;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export interface RouterCandidateValueAssessment {
  candidateId: string;
  status: RouterCandidateValueStatus;
  exclusionReason?: RouterValueExclusionReason;
  opportunities: CrossVenueOpportunity[];
  provenance: RouterCandidateProvenance;
  incrementalVsLegacy: boolean;
  incrementalVsPmxtRead: boolean;
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

export interface RouterValueEvaluationSummary {
  totalCandidates: number;
  valid: number;
  falsePositives: number;
  staleBookArtifacts: number;
  feeUnitDiscrepancies: number;
  excluded: number;
  incrementalValidCandidates: number;
  incrementalExecutableOpportunities: number;
  totalExecutableValueUsd: number;
  incrementalExecutableValueUsd: number;
}

export interface RouterValueEvaluationProvenance {
  input: {
    authoritativeScanRunId: string;
    shadowRunId: string;
    shadowRunAttemptId: string;
    routerClusterIds: string[];
    authoritativeMarketIds: string[];
  };
  provider: {
    authoritative: string;
    router: string;
    sourceExchanges: string[];
    llmModel: string;
  };
  timestamps: {
    authoritativeCapturedAt: string;
    routerCapturedAt: string;
    evaluatedAt: string;
  };
  config: {
    productionPromptVersion: string;
    shadowPromptVersion: string;
    calculatorOptions: Readonly<OpportunityCalculatorOptions>;
  };
}

export interface RouterValueEvaluationResult {
  assessments: RouterCandidateValueAssessment[];
  summary: RouterValueEvaluationSummary;
  calculatorOptions: Readonly<OpportunityCalculatorOptions>;
  provenance: RouterValueEvaluationProvenance;
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

export interface RouterValueEvaluationRepository {
  saveEvaluation(result: RouterValueEvaluationResult): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pipeline dependencies
// ---------------------------------------------------------------------------

export interface RouterValueEvaluatorDeps {
  normalizer: MarketNormalizer;
  equivalencePolicy: DeterministicEquivalencePolicy;
  opportunityCalculator: OpportunityCalculator;
  llmGateway: {
    evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord>;
  };
  buildProductionLlmRequest: (
    pair: CandidatePair,
    decision: EquivalenceDecision,
  ) => LlmEvaluationRequest;
  repository: RouterValueEvaluationRepository;
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface RouterValueEvaluationInput {
  projection: PmxtRouterProjectionResult;
  verifiedMarkets: VenueMarketSnapshot[];
  verifiedBooks: MarketBook[];
  calculatorOptions: Readonly<OpportunityCalculatorOptions>;
  legacyCandidatePairIds: ReadonlySet<string>;
  pmxtReadCandidatePairIds: ReadonlySet<string>;
  provenance: RouterValueEvaluationProvenance;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class PmxtRouterValueEvaluator {
  constructor(private readonly deps: RouterValueEvaluatorDeps) {}

  async evaluate(input: RouterValueEvaluationInput): Promise<RouterValueEvaluationResult> {
    const assessments: RouterCandidateValueAssessment[] = [];

    for (const candidate of input.projection.candidates) {
      const assessment = await this.assessCandidate(candidate, input);
      assessments.push(assessment);
    }

    const summary = buildSummary(assessments);
    const result: RouterValueEvaluationResult = {
      assessments,
      summary,
      calculatorOptions: input.calculatorOptions,
      provenance: input.provenance,
    };

    await this.deps.repository.saveEvaluation(result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Per-candidate assessment
  // -------------------------------------------------------------------------

  private async assessCandidate(
    candidate: PmxtRouterCandidate,
    input: RouterValueEvaluationInput,
  ): Promise<RouterCandidateValueAssessment> {
    const { calculatorOptions, provenance } = input;
    const evaluatedAt = provenance.timestamps.evaluatedAt;

    // 1. Find the projected edge for this candidate (hoisted before the
    //    relation check so we don't call findEdgeForCandidate twice)
    const edge = findEdgeForCandidate(input.projection, candidate);

    // 2. Verify relation is identity (defense in depth — checked before
    //    edge eligibility so a non-identity candidate can never pass even
    //    if a stale or malformed edge happens to exist)
    if (candidate.relation !== "identity") {
      return excludedAssessment(
        candidate,
        edge,
        "unapproved_relation_kind",
        evaluatedAt,
      );
    }

    // 3. Edge must exist and be eligible (direct rawMatch required)
    if (!edge || !edge.eligibleByDefault) {
      return excludedAssessment(
        candidate,
        edge,
        "missing_direct_edge",
        evaluatedAt,
      );
    }

    // 4. Find verified markets — check for ambiguity (duplicate native IDs)
    const marketResult = findVerifiedMarkets(
      input.verifiedMarkets,
      candidate.kalshiNativeId,
      candidate.polymarketNativeId,
    );
    if (marketResult.ambiguous) {
      return excludedAssessment(
        candidate,
        edge,
        "ambiguous_semantics",
        evaluatedAt,
      );
    }
    if (!marketResult.kalshi || !marketResult.polymarket) {
      return excludedAssessment(
        candidate,
        edge,
        "unverified_book",
        evaluatedAt,
      );
    }

    // 5. Find verified books
    const kalshiBook = findBook(input.verifiedBooks, "kalshi", candidate.kalshiNativeId);
    const polymarketBook = findBook(input.verifiedBooks, "polymarket", candidate.polymarketNativeId);
    if (!kalshiBook || !polymarketBook) {
      const kalshiNorm = marketResult.kalshi
        ? this.deps.normalizer.normalize(marketResult.kalshi)
        : undefined;
      const polymarketNorm = marketResult.polymarket
        ? this.deps.normalizer.normalize(marketResult.polymarket)
        : undefined;
      return excludedAssessment(
        candidate,
        edge,
        "unverified_book",
        evaluatedAt,
        kalshiNorm,
        polymarketNorm,
      );
    }

    // 6. Check book staleness
    const staleness = checkStaleness(kalshiBook, polymarketBook, calculatorOptions);
    if (staleness.stale) {
      const feeComparison = checkFeeResolution(kalshiBook, polymarketBook, calculatorOptions.feeSource);
      return {
        candidateId: candidate.id,
        status: "stale_book_artifact",
        opportunities: [],
        provenance: {
          edge,
          kalshiMarket: marketResult.kalshi
            ? this.deps.normalizer.normalize(marketResult.kalshi)
            : undefined,
          polymarketMarket: marketResult.polymarket
            ? this.deps.normalizer.normalize(marketResult.polymarket)
            : undefined,
          kalshiBook,
          polymarketBook,
          feeComparison,
          timestamp: {
            edgeCapturedAt: provenance.timestamps.routerCapturedAt,
            bookCapturedAt: kalshiBook.capturedAt,
            evaluatedAt,
          },
        },
        incrementalVsLegacy: false,
        incrementalVsPmxtRead: false,
      };
    }

    // 7. Normalize markets
    const kalshiNormalized = this.deps.normalizer.normalize(marketResult.kalshi);
    const polymarketNormalized = this.deps.normalizer.normalize(marketResult.polymarket);

    // 8. Build candidate pair (namespaced Router ID)
    const pair: CandidatePair = {
      id: candidate.id,
      kalshiMarket: kalshiNormalized,
      polymarketMarket: polymarketNormalized,
      reasons: ["router_projected_identity", ...edge.rawEdge ? [`${edge.relation}:${edge.confidence}`] : []],
    };

    // 9. Equivalence classification
    let decision = this.deps.equivalencePolicy.classify(pair);

    // 10. LLM shadow review for class B/D (same namespacing as PMXT-read parity)
    let llmEvaluation: LlmEvaluationRecord | undefined;
    if (decision.equivalenceClass === "B" || decision.equivalenceClass === "D") {
      const request = this.deps.buildProductionLlmRequest(pair, decision);
      const shadowRequest = buildPmxtShadowLlmRequest(request);
      llmEvaluation = await this.deps.llmGateway.evaluate(shadowRequest);
      decision = mergeLlmDecision(decision, llmEvaluation);
    }

    // 11. Fee resolution check
    const feeComparison = checkFeeResolution(kalshiBook, polymarketBook, calculatorOptions.feeSource);
    if (!feeComparison.resolved) {
      return {
        candidateId: candidate.id,
        status: "fee_unit_discrepancy",
        opportunities: [],
        provenance: {
          edge,
          kalshiMarket: kalshiNormalized,
          polymarketMarket: polymarketNormalized,
          kalshiBook,
          polymarketBook,
          feeComparison,
          timestamp: {
            edgeCapturedAt: provenance.timestamps.routerCapturedAt,
            bookCapturedAt: kalshiBook.capturedAt,
            evaluatedAt,
          },
          decision,
          llmEvaluation,
        },
        incrementalVsLegacy: false,
        incrementalVsPmxtRead: false,
      };
    }

    // 12. Calculate opportunities (only for class A)
    let opportunities: CrossVenueOpportunity[] = [];
    if (decision.equivalenceClass === "A") {
      opportunities = this.deps.opportunityCalculator.calculate(
        pair,
        decision,
        kalshiBook,
        polymarketBook,
        calculatorOptions,
      );
    } else {
      // Equivalence rejected — excluded
      return {
        candidateId: candidate.id,
        status: "excluded",
        exclusionReason: "equivalence_rejected",
        opportunities: [],
        provenance: {
          edge,
          kalshiMarket: kalshiNormalized,
          polymarketMarket: polymarketNormalized,
          kalshiBook,
          polymarketBook,
          feeComparison,
          timestamp: {
            edgeCapturedAt: provenance.timestamps.routerCapturedAt,
            bookCapturedAt: kalshiBook.capturedAt,
            evaluatedAt,
          },
          decision,
          llmEvaluation,
        },
        incrementalVsLegacy: false,
        incrementalVsPmxtRead: false,
      };
    }

    // 13. Classify: valid vs false positive
    const status: RouterCandidateValueStatus =
      opportunities.length > 0 ? "valid" : "false_positive";

    // 14. Determine incrementality
    const legacyPairId = `${kalshiNormalized.id}:${polymarketNormalized.id}`;
    const incrementalVsLegacy = !input.legacyCandidatePairIds.has(legacyPairId);
    const incrementalVsPmxtRead = !input.pmxtReadCandidatePairIds.has(legacyPairId);

    return {
      candidateId: candidate.id,
      status,
      opportunities,
      provenance: {
        edge,
        kalshiMarket: kalshiNormalized,
        polymarketMarket: polymarketNormalized,
        kalshiBook,
        polymarketBook,
        feeComparison,
        timestamp: {
          edgeCapturedAt: provenance.timestamps.routerCapturedAt,
          bookCapturedAt: kalshiBook.capturedAt,
          evaluatedAt,
        },
        decision,
        llmEvaluation,
      },
      incrementalVsLegacy,
      incrementalVsPmxtRead,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEdgeForCandidate(
  projection: PmxtRouterProjectionResult,
  candidate: PmxtRouterCandidate,
): PmxtRouterProjectedEdge | undefined {
  return projection.edges.find(
    (e) =>
      e.clusterId === candidate.clusterId &&
      e.kalshiMemberId === candidate.kalshiMemberId &&
      e.polymarketMemberId === candidate.polymarketMemberId,
  );
}

interface MarketLookupResult {
  kalshi?: VenueMarketSnapshot;
  polymarket?: VenueMarketSnapshot;
  ambiguous: boolean;
}

function findVerifiedMarkets(
  markets: VenueMarketSnapshot[],
  kalshiNativeId: string,
  polymarketNativeId: string,
): MarketLookupResult {
  const kalshiMatches = markets.filter(
    (m) => m.venue === "kalshi" && m.venueMarketId === kalshiNativeId,
  );
  const polymarketMatches = markets.filter(
    (m) => m.venue === "polymarket" && m.venueMarketId === polymarketNativeId,
  );

  return {
    kalshi: kalshiMatches[0],
    polymarket: polymarketMatches[0],
    ambiguous: kalshiMatches.length > 1 || polymarketMatches.length > 1,
  };
}

function findBook(
  books: MarketBook[],
  venue: "kalshi" | "polymarket",
  marketId: string,
): MarketBook | undefined {
  return books.find((b) => b.venue === venue && b.marketId === marketId);
}

function bookAgeMs(book: MarketBook, nowIso: string): number | undefined {
  const capturedAt = new Date(book.capturedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now)) return undefined;
  return now - capturedAt;
}

function checkStaleness(
  kalshiBook: MarketBook,
  polymarketBook: MarketBook,
  options: Readonly<OpportunityCalculatorOptions>,
): { stale: boolean } {
  if (kalshiBook.stale || polymarketBook.stale) return { stale: true };
  const kalshiAge = bookAgeMs(kalshiBook, options.now);
  const polymarketAge = bookAgeMs(polymarketBook, options.now);
  const maxAge = options.maxBookAgeMs;
  if (kalshiAge !== undefined && kalshiAge > maxAge) return { stale: true };
  if (polymarketAge !== undefined && polymarketAge > maxAge) return { stale: true };
  return { stale: false };
}

function checkFeeResolution(
  kalshiBook: MarketBook,
  polymarketBook: MarketBook,
  feeSource: string,
): { feeSource: string; resolved: boolean; discrepancy: string | null } {
  if (feeSource === "config") {
    return { feeSource, resolved: true, discrepancy: null };
  }

  // market-payload: Polymarket fee schedule must be present and valid
  const polyFee = extractFeeSchedule(polymarketBook);
  if (polyFee === null) {
    return {
      feeSource,
      resolved: false,
      discrepancy: "missing_polymarket_fee_schedule",
    };
  }

  return { feeSource, resolved: true, discrepancy: null };
}

function extractFeeSchedule(book: MarketBook): unknown {
  const raw = book.rawPayload;
  if (!raw) return null;
  const feeSchedule = raw.feeSchedule;
  if (feeSchedule !== undefined) return { feeSchedule };
  return null;
}

function mergeLlmDecision(
  decision: EquivalenceDecision,
  llmRecord: LlmEvaluationRecord,
): EquivalenceDecision {
  // Mirrors the production LLM merge in read-only-scanner.ts so the
  // evaluator produces identical equivalence classes for identical inputs.
  if (llmRecord.status !== "succeeded" || !llmRecord.parsedOutput) {
    return { ...decision, reasons: [...decision.reasons, `llm_${llmRecord.status}`] };
  }

  const verdict = llmRecord.parsedOutput as unknown as {
    equivalent: boolean;
    confidence: number;
  };

  if (!verdict.equivalent && verdict.confidence >= 0.7) {
    return {
      ...decision,
      equivalenceClass: "C",
      decision: "reject",
      reasons: [...decision.reasons, "llm_refuted_equivalence"],
    };
  }

  if (verdict.equivalent && verdict.confidence >= 0.7) {
    const promotedClass = promoteEquivalenceClass(decision, verdict.confidence);
    const promotedDecision = promoteEquivalenceDecision(decision, promotedClass);
    return {
      ...decision,
      equivalenceClass: promotedClass,
      decision: promotedDecision,
      reasons: [...decision.reasons, "llm_supported_equivalence"],
    };
  }

  return { ...decision, reasons: [...decision.reasons, "llm_inconclusive"] };
}

function promoteEquivalenceClass(
  decision: EquivalenceDecision,
  confidence: number,
): EquivalenceDecision["equivalenceClass"] {
  if (confidence < 0.7) return decision.equivalenceClass;
  if (decision.equivalenceClass === "D") return "B";
  if (decision.equivalenceClass !== "B") return decision.equivalenceClass;
  if (confidence < 0.9) return "B";
  const allReasonsSoft = decision.reasons.every((reason) =>
    SOFT_REVIEW_REASONS.has(reason),
  );
  return allReasonsSoft ? "A" : "B";
}

function promoteEquivalenceDecision(
  decision: EquivalenceDecision,
  promotedClass: EquivalenceDecision["equivalenceClass"],
): EquivalenceDecision["decision"] {
  if (promotedClass === "A") return "tradable";
  if (promotedClass === "B")
    return decision.decision === "tradable" ? "tradable" : "alert_only";
  if (promotedClass === "C") return "reject";
  return decision.decision;
}

const SOFT_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "ambiguity_flags_present",
  "resolution_source_missing",
  "resolution_source_differs",
  "resolution_source_differs_crypto_index",
  "deadline_same_day_time_differs",
  "threshold_close_but_not_identical",
  "llm_inconclusive",
  "llm_supported_equivalence",
  "deterministic_fields_match",
]);

function excludedAssessment(
  candidate: PmxtRouterCandidate,
  edge: PmxtRouterProjectedEdge | undefined,
  reason: RouterValueExclusionReason,
  evaluatedAt: string,
  kalshiMarket?: NormalizedMarket,
  polymarketMarket?: NormalizedMarket,
): RouterCandidateValueAssessment {
  return {
    candidateId: candidate.id,
    status: "excluded",
    exclusionReason: reason,
    opportunities: [],
    provenance: {
      edge: edge ?? {
        clusterId: candidate.clusterId,
        marketAId: candidate.kalshiMemberId,
        marketBId: candidate.polymarketMemberId,
        relation: candidate.relation,
        confidence: candidate.confidence,
        clusterRelations: [],
        clusterConfidence: 0,
        eligibleByDefault: false,
        rawEdge: {
          marketAId: candidate.kalshiMemberId,
          marketBId: candidate.polymarketMemberId,
          relation: candidate.relation,
          confidence: candidate.confidence,
        },
      },
      kalshiMarket,
      polymarketMarket,
      feeComparison: { feeSource: "unknown", resolved: false, discrepancy: "not_evaluated" },
      timestamp: {
        edgeCapturedAt: evaluatedAt,
        evaluatedAt,
      },
    },
    incrementalVsLegacy: false,
    incrementalVsPmxtRead: false,
  };
}

function buildSummary(assessments: RouterCandidateValueAssessment[]): RouterValueEvaluationSummary {
  let valid = 0;
  let falsePositives = 0;
  let staleBookArtifacts = 0;
  let feeUnitDiscrepancies = 0;
  let excluded = 0;
  let incrementalValidCandidates = 0;
  let incrementalExecutableOpportunities = 0;
  let totalExecutableValueUsd = 0;
  let incrementalExecutableValueUsd = 0;

  for (const a of assessments) {
    switch (a.status) {
      case "valid":
        valid++;
        if (a.incrementalVsLegacy) {
          incrementalValidCandidates++;
          incrementalExecutableOpportunities += a.opportunities.length;
          for (const opp of a.opportunities) {
            incrementalExecutableValueUsd += opp.executableSizeUsd;
          }
        }
        for (const opp of a.opportunities) {
          totalExecutableValueUsd += opp.executableSizeUsd;
        }
        break;
      case "false_positive":
        falsePositives++;
        break;
      case "stale_book_artifact":
        staleBookArtifacts++;
        break;
      case "fee_unit_discrepancy":
        feeUnitDiscrepancies++;
        break;
      case "excluded":
        excluded++;
        break;
    }
  }

  return {
    totalCandidates: assessments.length,
    valid,
    falsePositives,
    staleBookArtifacts,
    feeUnitDiscrepancies,
    excluded,
    incrementalValidCandidates,
    incrementalExecutableOpportunities,
    totalExecutableValueUsd,
    incrementalExecutableValueUsd,
  };
}
