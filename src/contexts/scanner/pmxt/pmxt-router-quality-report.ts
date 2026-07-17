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
}

export interface BinomialConfidenceInterval {
  confidenceLevel: number;
  lower: number;
  upper: number;
}

export type PmxtRouterQualityInconclusiveReason =
  | "insufficient_labeled_sample"
  | "zero_precision_denominator"
  | "zero_recall_denominator";

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

  for (const observation of observations) {
    for (const key of observation.stratumKeys) {
      if (!(key in protocol.eligibleCounts)) {
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
    protocol.confidenceLevel <= 0 ||
    protocol.confidenceLevel >= 1 ||
    !Number.isInteger(protocol.minimumSampleSize) ||
    protocol.minimumSampleSize < 1 ||
    Object.values(protocol.eligibleCounts).some(
      (count) => !Number.isInteger(count) || count < 0
    )
  ) {
    throw new Error("Invalid PMXT Router quality protocol");
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
  if (precisionDenominator === 0) {
    inconclusiveReasons.push("zero_precision_denominator");
  }
  if (recallDenominator === 0) {
    inconclusiveReasons.push("zero_recall_denominator");
  }

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
