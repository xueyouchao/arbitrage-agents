export type PmxtRouterHumanLabel = "identity" | "not_identity" | "inconclusive";

export interface PmxtRouterQualityObservation {
  id: string;
  stratumKeys: string[];
  routerPredictedIdentity: boolean;
  label: PmxtRouterHumanLabel;
}

export interface PmxtRouterQualityProtocol {
  protocolVersion: string;
  confidenceLevel: number;
  minimumSampleSize: number;
  eligibleCounts: Record<string, number>;
  frozenMembership?: Record<string, string[]>;
  frozenPredictions?: Record<string, boolean>;
}

export interface BinomialConfidenceInterval {
  confidenceLevel: number;
  lower: number;
  upper: number;
}

export type PmxtRouterQualityInconclusiveReason =
  | "insufficient_labeled_sample"
  | "insufficient_precision_sample"
  | "insufficient_recall_sample"
  | "insufficient_false_positive_sample"
  | "zero_precision_denominator"
  | "zero_recall_denominator"
  | "zero_false_positive_denominator";

export interface PmxtRouterStratumQuality {
  eligibleCount: number;
  selectedCount: number;
  labeledCount: number;
  routerPredictedPositiveCount: number;
  positiveLabelCount: number;
  truePositiveCount: number;
  falsePositiveCount: number;
  falseNegativeCount: number;
  trueNegativeCount: number;
  precision?: number;
  recall?: number;
  falsePositiveRate?: number;
  precisionInterval?: BinomialConfidenceInterval;
  recallInterval?: BinomialConfidenceInterval;
  falsePositiveRateInterval?: BinomialConfidenceInterval;
  status: "conclusive" | "inconclusive";
  inconclusiveReasons: PmxtRouterQualityInconclusiveReason[];
}

export interface PmxtRouterMatchingQualityReport {
  protocolVersion: string;
  confidenceLevel: number;
  minimumSampleSize: number;
  strata: Record<string, PmxtRouterStratumQuality>;
}

export function reportPmxtRouterMatchingQuality(
  protocol: PmxtRouterQualityProtocol,
  observations: PmxtRouterQualityObservation[]
): PmxtRouterMatchingQualityReport {
  validateProtocol(protocol);
  const observationsByStratum = new Map<string, PmxtRouterQualityObservation[]>();
  const observationIds = new Set<string>();

  for (const observation of observations) {
    validateObservation(observation);
    if (observationIds.has(observation.id)) {
      throw new Error(`Duplicate observation ${observation.id}`);
    }
    observationIds.add(observation.id);
    validateFrozenMembership(protocol, observation);
    const observedKeys = new Set<string>();
    for (const key of observation.stratumKeys) {
      if (observedKeys.has(key)) {
        throw new Error(`Observation ${observation.id} repeats stratum ${key}`);
      }
      observedKeys.add(key);
      if (!Object.hasOwn(protocol.eligibleCounts, key)) {
        throw new Error(`Observation ${observation.id} stratum ${key} is not in the frozen cohort`);
      }
      const current = observationsByStratum.get(key) ?? [];
      current.push(observation);
      observationsByStratum.set(key, current);
    }
  }

  const strata: Record<string, PmxtRouterStratumQuality> = {};
  for (const [key, eligibleCount] of Object.entries(protocol.eligibleCounts).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    strata[key] = reportStratum(
      eligibleCount,
      observationsByStratum.get(key) ?? [],
      protocol
    );
  }

  return {
    protocolVersion: protocol.protocolVersion,
    confidenceLevel: protocol.confidenceLevel,
    minimumSampleSize: protocol.minimumSampleSize,
    strata,
  };
}

function validateProtocol(protocol: PmxtRouterQualityProtocol): void {
  if (
    !protocol.protocolVersion.trim() ||
    !Number.isFinite(protocol.confidenceLevel) ||
    protocol.confidenceLevel <= 0 ||
    protocol.confidenceLevel >= 1 ||
    0.5 + protocol.confidenceLevel / 2 >= 1 ||
    !Number.isInteger(protocol.minimumSampleSize) ||
    protocol.minimumSampleSize < 1 ||
    Object.values(protocol.eligibleCounts).some(
      (count) => !Number.isInteger(count) || count < 0
    )
  ) {
    throw new Error("Invalid PMXT Router quality protocol");
  }
  if (protocol.frozenMembership) {
    if (!protocol.frozenPredictions) {
      throw new Error("PMXT Router frozen predictions are required with membership");
    }
    const membershipIds = Object.keys(protocol.frozenMembership);
    if (
      membershipIds.some((id) => typeof protocol.frozenPredictions?.[id] !== "boolean") ||
      Object.keys(protocol.frozenPredictions).some(
        (id) => !Object.hasOwn(protocol.frozenMembership!, id)
      )
    ) {
      throw new Error("PMXT Router frozen predictions do not match membership");
    }
    const counts: Record<string, number> = {};
    for (const keys of Object.values(protocol.frozenMembership)) {
      for (const key of new Set(keys)) counts[key] = (counts[key] ?? 0) + 1;
    }
    if (
      Object.keys(counts).some((key) => !Object.hasOwn(protocol.eligibleCounts, key)) ||
      Object.entries(protocol.eligibleCounts).some(([key, count]) => counts[key] !== count)
    ) {
      throw new Error("PMXT Router eligible counts do not match frozen membership");
    }
  }
}

function validateObservation(observation: PmxtRouterQualityObservation): void {
  if (!observation.id.trim()) throw new Error("PMXT Router observation ID is required");
  if (typeof observation.routerPredictedIdentity !== "boolean") {
    throw new Error(`Observation ${observation.id} has invalid Router prediction`);
  }
  if (!["identity", "not_identity", "inconclusive"].includes(observation.label)) {
    throw new Error(`Observation ${observation.id} has invalid human label`);
  }
  if (observation.stratumKeys.some((key) => typeof key !== "string" || !key.trim())) {
    throw new Error(`Observation ${observation.id} has invalid stratum key`);
  }
}

function validateFrozenMembership(
  protocol: PmxtRouterQualityProtocol,
  observation: PmxtRouterQualityObservation
): void {
  if (!protocol.frozenMembership) return;
  const frozenKeys = protocol.frozenMembership[observation.id];
  if (!frozenKeys) {
    throw new Error(`Observation ${observation.id} is not in the frozen cohort`);
  }
  if (
    frozenKeys.length !== observation.stratumKeys.length ||
    frozenKeys.some((key) => !observation.stratumKeys.includes(key))
  ) {
    throw new Error(`Observation ${observation.id} does not match frozen strata`);
  }
  const frozenPrediction = protocol.frozenPredictions?.[observation.id];
  if (frozenPrediction !== observation.routerPredictedIdentity) {
    throw new Error(`Observation ${observation.id} does not match frozen Router prediction`);
  }
}

function reportStratum(
  eligibleCount: number,
  selected: PmxtRouterQualityObservation[],
  protocol: PmxtRouterQualityProtocol
): PmxtRouterStratumQuality {
  const labeled = selected.filter((observation) => observation.label !== "inconclusive");
  const truePositiveCount = labeled.filter(
    (observation) => observation.routerPredictedIdentity && observation.label === "identity"
  ).length;
  const falsePositiveCount = labeled.filter(
    (observation) =>
      observation.routerPredictedIdentity && observation.label === "not_identity"
  ).length;
  const falseNegativeCount = labeled.filter(
    (observation) => !observation.routerPredictedIdentity && observation.label === "identity"
  ).length;
  const trueNegativeCount = labeled.filter(
    (observation) =>
      !observation.routerPredictedIdentity && observation.label === "not_identity"
  ).length;
  const precisionDenominator = truePositiveCount + falsePositiveCount;
  const recallDenominator = truePositiveCount + falseNegativeCount;
  const negativeDenominator = falsePositiveCount + trueNegativeCount;
  const precision = ratio(truePositiveCount, precisionDenominator);
  const recall = ratio(truePositiveCount, recallDenominator);
  const falsePositiveRate = ratio(falsePositiveCount, negativeDenominator);
  const inconclusiveReasons: PmxtRouterQualityInconclusiveReason[] = [];

  if (labeled.length < protocol.minimumSampleSize) {
    inconclusiveReasons.push("insufficient_labeled_sample");
  }
  addMetricSampleReason(
    inconclusiveReasons,
    precisionDenominator,
    protocol.minimumSampleSize,
    "zero_precision_denominator",
    "insufficient_precision_sample"
  );
  addMetricSampleReason(
    inconclusiveReasons,
    recallDenominator,
    protocol.minimumSampleSize,
    "zero_recall_denominator",
    "insufficient_recall_sample"
  );
  addMetricSampleReason(
    inconclusiveReasons,
    negativeDenominator,
    protocol.minimumSampleSize,
    "zero_false_positive_denominator",
    "insufficient_false_positive_sample"
  );

  return {
    eligibleCount,
    selectedCount: selected.length,
    labeledCount: labeled.length,
    routerPredictedPositiveCount: labeled.filter(
      (observation) => observation.routerPredictedIdentity
    ).length,
    positiveLabelCount: labeled.filter((observation) => observation.label === "identity")
      .length,
    truePositiveCount,
    falsePositiveCount,
    falseNegativeCount,
    trueNegativeCount,
    precision,
    recall,
    falsePositiveRate,
    precisionInterval: wilsonInterval(
      truePositiveCount,
      precisionDenominator,
      protocol.confidenceLevel
    ),
    recallInterval: wilsonInterval(
      truePositiveCount,
      recallDenominator,
      protocol.confidenceLevel
    ),
    falsePositiveRateInterval: wilsonInterval(
      falsePositiveCount,
      negativeDenominator,
      protocol.confidenceLevel
    ),
    status: inconclusiveReasons.length === 0 ? "conclusive" : "inconclusive",
    inconclusiveReasons,
  };
}

function addMetricSampleReason(
  reasons: PmxtRouterQualityInconclusiveReason[],
  denominator: number,
  minimumSampleSize: number,
  zeroReason: PmxtRouterQualityInconclusiveReason,
  insufficientReason: PmxtRouterQualityInconclusiveReason
): void {
  if (denominator === 0) {
    reasons.push(zeroReason);
  } else if (denominator < minimumSampleSize) {
    reasons.push(insufficientReason);
  }
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function wilsonInterval(
  successes: number,
  total: number,
  confidenceLevel: number
): BinomialConfidenceInterval | undefined {
  if (total === 0) return undefined;
  const z = inverseStandardNormal(0.5 + confidenceLevel / 2);
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total));
  return {
    confidenceLevel,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

// Acklam's rational approximation, accurate enough for statistical reporting.
export function inverseStandardNormal(probability: number): number {
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
