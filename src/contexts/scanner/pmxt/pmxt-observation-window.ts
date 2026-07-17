// Issue #99: Operate the PMXT observation window and issue a decision memo.
//
// This module implements the frozen analysis protocol, observation-window
// gate evaluation, and decision-memo generation described in
// docs/PMXT-MIGRATION-PLAN.md §10.2, §14 (Phase 7), §15, and §16.
//
// Key invariants:
//   - The analysis protocol freezes denominators, minimum eligible samples,
//     time/activity strata, retry/partial treatment, exclusions, missing-data
//     rules, tolerances, and CI method BEFORE the window begins.
//   - Changing sampling, config fingerprint, mapper/domain/prompt/model
//     version, or analysis protocol starts a new cohort/window.
//   - Under-sampled strata are marked inconclusive; gates are never weakened
//     after results are known.
//   - Any recommendation for authoritative use explicitly requires a separate
//     cutover architecture and rollback plan.

// ---------------------------------------------------------------------------
// Protocol input (pre-freeze)
// ---------------------------------------------------------------------------

export interface ObservationProtocolInput {
  protocolVersion: string;
  frozenAt: string;
  confidenceLevel: number;
  minimumSuccessfulRuns: number;
  minimumDurationDays: number;
  activityStrata: readonly string[];
  perStratumMinimumSamples: Record<string, number>;
  retryPolicy: {
    maxRetries: number;
    partialTreatment: "exclude" | "include_flagged";
  };
  exclusionReasons: readonly string[];
  missingDataRule: "mark_inconclusive" | "exclude";
  tolerances: {
    topOfBookTickDeviation: number;
    executableSizeDeviationPct: number;
  };
  confidenceIntervalMethod: "wilson";
  configFingerprint: string;
  mapperVersion: string;
  domainVersion: string;
  promptVersion: string;
  modelVersion: string;
  sampleRate: { numerator: number; denominator: number };
}

// ---------------------------------------------------------------------------
// Frozen protocol (immutable snapshot)
// ---------------------------------------------------------------------------

export interface FrozenObservationProtocol
  extends Omit<ObservationProtocolInput, "activityStrata" | "exclusionReasons"> {
  readonly activityStrata: readonly string[];
  readonly exclusionReasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Evidence collected during the observation window
// ---------------------------------------------------------------------------

export interface ActivityPeriod {
  stratum: string;
  periods: number;
}

export interface WindowReliability {
  meanShadowRuntimeMs: number;
  p95ShadowRuntimeMs: number;
  meanRequestsPerRun: number;
  rateLimitHits: number;
  circuitBreakerTrips: number;
}

export interface ObservationWindowEvidence {
  windowStartedAt: string;
  windowEndedAt: string;
  successfulRuns: number;
  failedRuns: number;
  partialRuns: number;
  timedOutRuns: number;
  retriedRuns: number;
  activityPeriods: ActivityPeriod[];
  perStratumSamples: Record<string, number>;
  perStratumExclusions: Record<string, number>;
  perStratumExclusionBreakdown: Record<string, Record<string, number>>;
  coverageOverlapPct: number;
  topOfBookWithinTickPct: number;
  shadowCompletionRate: number;
  routerPrecision: number;
  routerRecall: number;
  routerLabeledPairs: number;
  routerFalsePositives: number;
  incrementalValidCandidates: number;
  incrementalExecutableOpportunities: number;
  totalExecutableValueUsd: number;
  incrementalExecutableValueUsd: number;
  estimatedMonthlyCostUsd: number;
  projectedMonthlyCredits: number;
  reliability: WindowReliability;
  safetyIncidents: string[];
  configFingerprintUnchanged: boolean;
  protocolUnchanged: boolean;
}

// ---------------------------------------------------------------------------
// Gate evaluation types
// ---------------------------------------------------------------------------

export type WindowGateStatus = "passed" | "failed" | "inconclusive";

export interface WindowGates {
  duration: WindowGateStatus;
  runCount: WindowGateStatus;
  activityMix: WindowGateStatus;
  perStratumSamples: Record<string, WindowGateStatus>;
  protocolIntegrity: WindowGateStatus;
  configIntegrity: WindowGateStatus;
  safety: WindowGateStatus;
}

// ---------------------------------------------------------------------------
// Decision memo types
// ---------------------------------------------------------------------------

export type DecisionOutcome = "A" | "B" | "C" | "D" | "E" | "F" | "inconclusive";

export interface DecisionMemoGate {
  name: string;
  status: WindowGateStatus;
  threshold: string;
  observed: string;
}

export interface BinomialCI {
  confidenceLevel: number;
  lower: number;
  upper: number;
}

interface ScaledBinomialCI extends BinomialCI {
  mapToPct(): BinomialCI;
}

export interface DecisionMemoPointEstimates {
  coverageOverlapPct: number;
  topOfBookWithinTickPct: number;
  shadowCompletionRate: number;
  routerPrecision: number;
  routerRecall: number;
  routerLabeledPairs: number;
  routerFalsePositives: number;
  incrementalValidCandidates: number;
  incrementalExecutableOpportunities: number;
}

export interface DecisionMemoConfidenceIntervals {
  routerPrecision?: BinomialCI;
  routerRecall?: BinomialCI;
  coverageOverlap?: BinomialCI;
  topOfBookWithinTick?: BinomialCI;
  shadowCompletion?: BinomialCI;
}

export interface DecisionMemoCosts {
  estimatedMonthlyCostUsd: number;
  projectedMonthlyCredits: number;
  totalExecutableValueUsd: number;
  incrementalExecutableValueUsd: number;
}

export interface PmxtDecisionMemo {
  protocolVersion: string;
  outcome: DecisionOutcome;
  recommendation: string;
  cutoverRequired: boolean;
  cutoverNote: string;
  eligibleCounts: Record<string, number>;
  exclusions: Record<string, number>;
  exclusionBreakdown: Record<string, Record<string, number>>;
  pointEstimates: DecisionMemoPointEstimates;
  confidenceIntervals: DecisionMemoConfidenceIntervals;
  costs: DecisionMemoCosts;
  reliability: WindowReliability;
  limitations: string[];
  gates: DecisionMemoGate[];
}

export interface ObservationWindowResult {
  gates: WindowGates;
  windowComplete: boolean;
  requiresNewWindow: boolean;
  decisionMemo: PmxtDecisionMemo;
}

// ---------------------------------------------------------------------------
// Acceptance gate thresholds (from migration plan §15)
// ---------------------------------------------------------------------------

const READ_OVERLAP_THRESHOLD_PCT = 95;
const TOP_OF_BOOK_WITHIN_TICK_THRESHOLD_PCT = 95;
const SHADOW_COMPLETION_THRESHOLD_PCT = 99;
const ROUTER_PRECISION_THRESHOLD_PCT = 98;
const ROUTER_MIN_LABELED_PAIRS = 200;
const SAFETY_INCIDENT_OUTCOMES: string[] = [
  "yes_no_inversion_detected",
  "unit_conversion_defect",
  "authoritative_scan_corrupted",
  "secret_in_persisted_payload",
  "local_sidecar_started",
];

// ---------------------------------------------------------------------------
// freezeObservationProtocol
// ---------------------------------------------------------------------------

export function freezeObservationProtocol(
  input: ObservationProtocolInput
): FrozenObservationProtocol {
  validateProtocolInput(input);
  return {
    ...input,
    frozenAt: input.frozenAt,
    activityStrata: [...input.activityStrata],
    exclusionReasons: [...input.exclusionReasons],
    tolerances: { ...input.tolerances },
    perStratumMinimumSamples: { ...input.perStratumMinimumSamples },
    retryPolicy: { ...input.retryPolicy },
    sampleRate: { ...input.sampleRate },
  };
}

function validateProtocolInput(input: ObservationProtocolInput): void {
  if (!input.protocolVersion.trim()) {
    throw new Error("PMXT observation protocol version is required");
  }
  if (
    !Number.isFinite(input.confidenceLevel) ||
    input.confidenceLevel <= 0 ||
    input.confidenceLevel >= 1
  ) {
    throw new Error("PMXT observation protocol confidence level must be in (0, 1)");
  }
  if (!Number.isInteger(input.minimumSuccessfulRuns) || input.minimumSuccessfulRuns < 1) {
    throw new Error("PMXT observation protocol minimum successful runs must be a positive integer");
  }
  if (!Number.isInteger(input.minimumDurationDays) || input.minimumDurationDays < 1) {
    throw new Error("PMXT observation protocol minimum duration must be a positive integer");
  }
  if (input.activityStrata.length === 0) {
    throw new Error("PMXT observation protocol activity strata must not be empty");
  }
  const stratumSet = new Set(input.activityStrata);
  if (stratumSet.size !== input.activityStrata.length) {
    throw new Error("PMXT observation protocol activity strata must be unique");
  }
  for (const stratum of input.activityStrata) {
    if (!Object.hasOwn(input.perStratumMinimumSamples, stratum)) {
      throw new Error(
        `PMXT observation protocol per-stratum minimum samples missing stratum "${stratum}"`
      );
    }
    const min = input.perStratumMinimumSamples[stratum];
    if (!Number.isInteger(min) || min < 1) {
      throw new Error(
        `PMXT observation protocol per-stratum minimum samples for "${stratum}" must be a positive integer`
      );
    }
  }
  if (!Number.isInteger(input.retryPolicy.maxRetries) || input.retryPolicy.maxRetries < 0) {
    throw new Error("PMXT observation protocol retry policy max retries must be a non-negative integer");
  }
  if (input.exclusionReasons.length === 0) {
    throw new Error("PMXT observation protocol exclusion reasons must not be empty");
  }
  if (input.confidenceIntervalMethod !== "wilson") {
    throw new Error(
      `PMXT observation protocol confidence interval method "${input.confidenceIntervalMethod}" is not supported`
    );
  }
  if (!input.configFingerprint.trim()) {
    throw new Error("PMXT observation protocol config fingerprint is required");
  }
  if (!input.mapperVersion.trim()) {
    throw new Error("PMXT observation protocol mapper version is required");
  }
  if (!input.domainVersion.trim()) {
    throw new Error("PMXT observation protocol domain version is required");
  }
  if (!input.promptVersion.trim()) {
    throw new Error("PMXT observation protocol prompt version is required");
  }
  if (!input.modelVersion.trim()) {
    throw new Error("PMXT observation protocol model version is required");
  }
}

// ---------------------------------------------------------------------------
// evaluateObservationWindow
// ---------------------------------------------------------------------------

export function evaluateObservationWindow(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence
): ObservationWindowResult {
  validateEvidence(protocol, evidence);

  const gates = evaluateGates(protocol, evidence);
  const windowComplete = isWindowComplete(gates);
  const requiresNewWindow =
    gates.protocolIntegrity === "failed" || gates.configIntegrity === "failed";
  const decisionMemo = buildDecisionMemo(protocol, evidence, gates);

  return { gates, windowComplete, requiresNewWindow, decisionMemo };
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

function validateEvidence(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence
): void {
  const protocolStrata = new Set(protocol.activityStrata);
  const evidenceStrata = new Set(Object.keys(evidence.perStratumSamples));

  for (const stratum of evidenceStrata) {
    if (!protocolStrata.has(stratum)) {
      throw new Error(
        `PMXT observation evidence has unknown stratum "${stratum}" not in frozen protocol`
      );
    }
  }
  for (const stratum of protocolStrata) {
    if (!evidenceStrata.has(stratum)) {
      throw new Error(
        `PMXT observation evidence is missing stratum "${stratum}" from frozen protocol`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

function evaluateGates(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence
): WindowGates {
  const durationDays = elapsedDays(evidence.windowStartedAt, evidence.windowEndedAt);

  const duration: WindowGateStatus =
    durationDays >= protocol.minimumDurationDays ? "passed" : "failed";

  const runCount: WindowGateStatus =
    evidence.successfulRuns >= protocol.minimumSuccessfulRuns ? "passed" : "failed";

  const activityPeriodsByStratum = new Map(
    evidence.activityPeriods.map((p) => [p.stratum, p.periods])
  );
  const activityMix: WindowGateStatus = protocol.activityStrata.every(
    (s) => (activityPeriodsByStratum.get(s) ?? 0) > 0
  )
    ? "passed"
    : "failed";

  const perStratumSamples: Record<string, WindowGateStatus> = {};
  for (const stratum of protocol.activityStrata) {
    const observed = evidence.perStratumSamples[stratum] ?? 0;
    const minimum = protocol.perStratumMinimumSamples[stratum];
    perStratumSamples[stratum] =
      observed >= minimum ? "passed" : "inconclusive";
  }

  const protocolIntegrity: WindowGateStatus = evidence.protocolUnchanged
    ? "passed"
    : "failed";

  const configIntegrity: WindowGateStatus = evidence.configFingerprintUnchanged
    ? "passed"
    : "failed";

  const safety: WindowGateStatus =
    evidence.safetyIncidents.length === 0 ? "passed" : "failed";

  return {
    duration,
    runCount,
    activityMix,
    perStratumSamples,
    protocolIntegrity,
    configIntegrity,
    safety,
  };
}

function isWindowComplete(gates: WindowGates): boolean {
  const topLevelGates: WindowGateStatus[] = [
    gates.duration,
    gates.runCount,
    gates.activityMix,
    gates.protocolIntegrity,
    gates.configIntegrity,
    gates.safety,
  ];
  if (topLevelGates.some((g) => g === "failed")) return false;
  if (Object.values(gates.perStratumSamples).some((g) => g !== "passed")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Decision memo construction
// ---------------------------------------------------------------------------

function buildDecisionMemo(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence,
  gates: WindowGates
): PmxtDecisionMemo {
  const limitations = collectLimitations(protocol, evidence, gates);
  const outcome = selectOutcome(protocol, evidence, gates);
  const cutoverRequired = outcome !== "F" && outcome !== "inconclusive";

  return {
    protocolVersion: protocol.protocolVersion,
    outcome,
    recommendation: recommendationFor(outcome),
    cutoverRequired,
    cutoverNote: cutoverRequired ? cutoverNoteText() : "",
    eligibleCounts: { ...evidence.perStratumSamples },
    exclusions: { ...evidence.perStratumExclusions },
    exclusionBreakdown: deepCopyExclusionBreakdown(evidence.perStratumExclusionBreakdown),
    pointEstimates: {
      coverageOverlapPct: evidence.coverageOverlapPct,
      topOfBookWithinTickPct: evidence.topOfBookWithinTickPct,
      shadowCompletionRate: evidence.shadowCompletionRate,
      routerPrecision: evidence.routerPrecision,
      routerRecall: evidence.routerRecall,
      routerLabeledPairs: evidence.routerLabeledPairs,
      routerFalsePositives: evidence.routerFalsePositives,
      incrementalValidCandidates: evidence.incrementalValidCandidates,
      incrementalExecutableOpportunities: evidence.incrementalExecutableOpportunities,
    },
    confidenceIntervals: buildConfidenceIntervals(protocol, evidence),
    costs: {
      estimatedMonthlyCostUsd: evidence.estimatedMonthlyCostUsd,
      projectedMonthlyCredits: evidence.projectedMonthlyCredits,
      totalExecutableValueUsd: evidence.totalExecutableValueUsd,
      incrementalExecutableValueUsd: evidence.incrementalExecutableValueUsd,
    },
    reliability: { ...evidence.reliability },
    limitations,
    gates: buildGateReport(protocol, evidence, gates),
  };
}

function collectLimitations(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence,
  gates: WindowGates
): string[] {
  const limitations: string[] = [];

  for (const stratum of protocol.activityStrata) {
    const status = gates.perStratumSamples[stratum];
    if (status === "inconclusive") {
      const observed = evidence.perStratumSamples[stratum] ?? 0;
      const minimum = protocol.perStratumMinimumSamples[stratum];
      limitations.push(
        `${stratum} stratum is inconclusive (${observed} < ${minimum} eligible)`
      );
    }
  }

  for (const incident of evidence.safetyIncidents) {
    limitations.push(`safety incident: ${incident}`);
  }

  if (evidence.reliability.rateLimitHits > 0) {
    limitations.push(
      `rate limiting observed (${evidence.reliability.rateLimitHits} hits)`
    );
  }

  if (evidence.reliability.circuitBreakerTrips > 0) {
    limitations.push(
      `circuit breaker tripped (${evidence.reliability.circuitBreakerTrips} times)`
    );
  }

  return limitations;
}

function buildConfidenceIntervals(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence
): DecisionMemoConfidenceIntervals {
  // Wilson intervals are computed in [0,1] and then scaled to percentage
  // for metrics reported as percentages, so the CI bounds are on the same
  // scale as the point estimates in the memo.
  const precisionPct = pctToProportion(evidence.routerPrecision);
  return {
    routerPrecision: wilsonInterval(
      Math.round(evidence.routerLabeledPairs * precisionPct),
      evidence.routerLabeledPairs,
      protocol.confidenceLevel
    )?.mapToPct(),
    routerRecall: evidence.routerLabeledPairs > 0
      ? wilsonInterval(
          Math.round(evidence.routerLabeledPairs * pctToProportion(evidence.routerRecall)),
          evidence.routerLabeledPairs,
          protocol.confidenceLevel
        )?.mapToPct()
      : undefined,
    coverageOverlap: wilsonInterval(
      Math.round(evidence.successfulRuns * pctToProportion(evidence.coverageOverlapPct)),
      evidence.successfulRuns,
      protocol.confidenceLevel
    )?.mapToPct(),
    topOfBookWithinTick: wilsonInterval(
      Math.round(evidence.successfulRuns * pctToProportion(evidence.topOfBookWithinTickPct)),
      evidence.successfulRuns,
      protocol.confidenceLevel
    )?.mapToPct(),
    shadowCompletion: wilsonInterval(
      Math.round(evidence.successfulRuns * pctToProportion(evidence.shadowCompletionRate)),
      evidence.successfulRuns + evidence.failedRuns,
      protocol.confidenceLevel
    )?.mapToPct(),
  };
}

function pctToProportion(pct: number): number {
  return pct / 100;
}

function buildGateReport(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence,
  gates: WindowGates
): DecisionMemoGate[] {
  const durationDays = elapsedDays(evidence.windowStartedAt, evidence.windowEndedAt);
  const gateList: DecisionMemoGate[] = [
    {
      name: "duration",
      status: gates.duration,
      threshold: `>= ${protocol.minimumDurationDays} days`,
      observed: `${durationDays} days`,
    },
    {
      name: "run_count",
      status: gates.runCount,
      threshold: `>= ${protocol.minimumSuccessfulRuns} successful runs`,
      observed: `${evidence.successfulRuns} successful runs`,
    },
    {
      name: "activity_mix",
      status: gates.activityMix,
      threshold: `all strata have >0 periods: ${protocol.activityStrata.join(", ")}`,
      observed: evidence.activityPeriods
        .map((p) => `${p.stratum}=${p.periods}`)
        .join(", "),
    },
    {
      name: "per_stratum_samples",
      status: Object.values(gates.perStratumSamples).every((s) => s === "passed")
        ? "passed"
        : Object.values(gates.perStratumSamples).some((s) => s === "failed")
          ? "failed"
          : "inconclusive",
      threshold: protocol.activityStrata
        .map(
          (s) => `${s}>=${protocol.perStratumMinimumSamples[s]}`
        )
        .join(", "),
      observed: protocol.activityStrata
        .map((s) => `${s}=${evidence.perStratumSamples[s] ?? 0}`)
        .join(", "),
    },
    {
      name: "protocol_integrity",
      status: gates.protocolIntegrity,
      threshold: "protocol unchanged during window",
      observed: evidence.protocolUnchanged ? "unchanged" : "changed",
    },
    {
      name: "config_integrity",
      status: gates.configIntegrity,
      threshold: "config fingerprint unchanged during window",
      observed: evidence.configFingerprintUnchanged ? "unchanged" : "changed",
    },
    {
      name: "safety",
      status: gates.safety,
      threshold: "zero safety incidents",
      observed:
        evidence.safetyIncidents.length === 0
          ? "0 incidents"
          : `${evidence.safetyIncidents.length} incidents: ${evidence.safetyIncidents.join(", ")}`,
    },
  ];

  return gateList;
}

// ---------------------------------------------------------------------------
// Outcome selection (migration plan §16)
// ---------------------------------------------------------------------------

function selectOutcome(
  protocol: FrozenObservationProtocol,
  evidence: ObservationWindowEvidence,
  gates: WindowGates
): DecisionOutcome {
  // Safety incidents or protocol/config integrity violations → reject
  if (gates.safety === "failed") return "F";
  if (gates.protocolIntegrity === "failed") return "F";
  if (gates.configIntegrity === "failed") return "F";

  // Under-sampled strata or incomplete window → inconclusive
  if (Object.values(gates.perStratumSamples).some((s) => s !== "passed")) {
    return "inconclusive";
  }
  if (
    gates.duration !== "passed" ||
    gates.runCount !== "passed" ||
    gates.activityMix !== "passed"
  ) {
    return "inconclusive";
  }

  // Evaluate read and Router quality against acceptance gates (§15)
  const readsPass = readsPassGates(evidence);
  const routerPass = routerPassGates(evidence);
  const routerAddsValue = evidence.incrementalValidCandidates > 0;

  // Outcome C: both tracks independently pass their gates
  if (readsPass && routerPass && routerAddsValue) return "C";

  // Outcome A: keep direct reads, adopt Router as supplementary
  // — Router passes precision gate and adds value; reads quality is
  //   irrelevant because direct reads remain authoritative.
  if (!readsPass && routerPass && routerAddsValue) return "A";

  // Outcome B: adopt hosted reads, retain internal matching
  // — Reads pass their gates; Router does not add value (either fails
  //   precision or produces no incremental candidates).
  if (readsPass && (!routerPass || !routerAddsValue)) return "B";

  // Outcome D: hybrid verification — partial value on both sides but
  // neither track independently passes adoption gates. PMXT serves as
  // a verifier or gap detector rather than an authoritative source.
  if (!readsPass && !routerPass && routerAddsValue) return "D";

  // Outcome F: both tracks fail and neither adds value
  return "F";
}

function readsPassGates(evidence: ObservationWindowEvidence): boolean {
  return (
    evidence.coverageOverlapPct >= READ_OVERLAP_THRESHOLD_PCT &&
    evidence.topOfBookWithinTickPct >= TOP_OF_BOOK_WITHIN_TICK_THRESHOLD_PCT &&
    evidence.shadowCompletionRate >= SHADOW_COMPLETION_THRESHOLD_PCT
  );
}

function routerPassGates(evidence: ObservationWindowEvidence): boolean {
  return (
    evidence.routerLabeledPairs >= ROUTER_MIN_LABELED_PAIRS &&
    evidence.routerPrecision >= ROUTER_PRECISION_THRESHOLD_PCT
  );
}

function recommendationFor(outcome: DecisionOutcome): string {
  switch (outcome) {
    case "A":
      return "Keep direct reads, adopt PMXT Hosted Router as a supplementary candidate-discovery source.";
    case "B":
      return "Adopt PMXT Hosted reads, retain internal matching. Requires a separate cutover plan.";
    case "C":
      return "Adopt both PMXT Hosted reads and Router. Requires a separate production architecture decision.";
    case "D":
      return "Hybrid verification: use direct reads as authoritative while PMXT serves as an independent verifier or gap detector.";
    case "E":
      return "Evaluate PMXT self-hosted reads while retaining Hosted Router. This becomes a new plan.";
    case "F":
      return "reject PMXT. Disable flags, retain the current implementation, preserve the evaluation memo.";
    case "inconclusive":
      return "Observation window is inconclusive. extend the window or address under-sampled strata before selecting an outcome.";
  }
}

function cutoverNoteText(): string {
  return (
    "This recommendation does not authorize production cutover. " +
    "Any adoption for authoritative use explicitly requires a separate cutover " +
    "architecture and rollback plan, including dependency-failure behavior, " +
    "fallback verification, and a rollback drill proving restoration of direct " +
    "authoritative reads within one worker interval."
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsedDays(startedAt: string, endedAt: string): number {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

function deepCopyExclusionBreakdown(
  breakdown: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [key, inner] of Object.entries(breakdown)) {
    result[key] = { ...inner };
  }
  return result;
}

function wilsonInterval(
  successes: number,
  total: number,
  confidenceLevel: number
): ScaledBinomialCI | undefined {
  if (total === 0) return undefined;
  const z = inverseStandardNormal(0.5 + confidenceLevel / 2);
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total));
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return {
    confidenceLevel,
    lower,
    upper,
    mapToPct(): BinomialCI {
      return { confidenceLevel, lower: lower * 100, upper: upper * 100 };
    },
  };
}

// Acklam's rational approximation for the inverse standard normal CDF.
function inverseStandardNormal(probability: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243, -0.322396458041, -2.40075827716, -2.549732539343, 4.374664141465, 2.938163982699];
  const d = [0.00778469570904, 0.32246712907, 2.445134137143, 3.754408661907];
  const low = 0.02425;
  const high = 1 - low;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
