import { NormalizedMarket } from "../../matching/domain/normalized-market";
import { PmxtRouterMatchRelation } from "./pmxt-router-match-projector";

export type PmxtRouterCandidateSource =
  | "shared"
  | "legacy_only"
  | "router_only"
  | "near_miss";
export type PmxtRouterConfidenceBand = "low" | "medium" | "high" | "not_applicable";
export type PmxtRouterCryptoThresholdBand =
  | "exact"
  | "within_one_dollar"
  | "over_one_dollar"
  | "missing"
  | "not_crypto";
export type PmxtRouterCryptoDeadlineBand =
  | "within_one_minute"
  | "same_utc_day"
  | "different_utc_day"
  | "missing"
  | "not_crypto";

export interface PmxtRouterLabelingCandidate {
  id: string;
  kalshiMarket: NormalizedMarket;
  polymarketMarket: NormalizedMarket;
  legacyCandidate: boolean;
  routerCandidate: boolean;
  routerRelation?: PmxtRouterMatchRelation;
  routerConfidence?: number;
  sameTitleDifferentResolution?: boolean;
}

export interface PmxtRouterFrozenStrata {
  source: PmxtRouterCandidateSource;
  relation: PmxtRouterMatchRelation | "not_applicable";
  confidence: PmxtRouterConfidenceBand;
  cryptoThreshold: PmxtRouterCryptoThresholdBand;
  cryptoDeadline: PmxtRouterCryptoDeadlineBand;
  nearMiss: "same_title_different_resolution" | "none";
}

export interface PmxtRouterFrozenLabelingItem extends PmxtRouterLabelingCandidate {
  strata: PmxtRouterFrozenStrata;
  stratumKeys: string[];
  eligibleCounts: Record<string, number>;
}

export interface PmxtRouterLabelingProtocol {
  protocolVersion: string;
  frozenAt: string;
  confidenceBands: readonly [number, number];
  minimumSampleSize: number;
}

export interface PmxtRouterFrozenLabelingCohort extends PmxtRouterLabelingProtocol {
  items: PmxtRouterFrozenLabelingItem[];
  eligibleCounts: Record<string, number>;
  frozenMembership: Record<string, string[]>;
  frozenPredictions: Record<string, boolean>;
}

export function buildFrozenPmxtRouterLabelingCohort(
  candidates: PmxtRouterLabelingCandidate[],
  protocol: PmxtRouterLabelingProtocol
): PmxtRouterFrozenLabelingCohort {
  validateProtocol(protocol);
  const candidateIds = new Set<string>();
  const prepared = candidates.map((candidate) => {
    if (candidateIds.has(candidate.id)) {
      throw new Error(`Duplicate labeling candidate ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (
      candidate.routerConfidence !== undefined &&
      (!Number.isFinite(candidate.routerConfidence) ||
        candidate.routerConfidence < 0 ||
        candidate.routerConfidence > 1)
    ) {
      throw new Error(`Candidate ${candidate.id} has invalid Router confidence`);
    }
    const strata = candidateStrata(candidate, protocol.confidenceBands);
    const stratumKeys = Object.entries(strata).map(([dimension, value]) =>
      `${dimension}=${value}`
    );
    return { ...candidate, strata, stratumKeys };
  });
  const eligibleCounts: Record<string, number> = {};
  for (const item of prepared) {
    for (const key of item.stratumKeys) {
      eligibleCounts[key] = (eligibleCounts[key] ?? 0) + 1;
    }
  }

  return {
    ...protocol,
    confidenceBands: [...protocol.confidenceBands] as [number, number],
    items: prepared.map((item) => ({ ...item, eligibleCounts: { ...eligibleCounts } })),
    eligibleCounts,
    frozenMembership: Object.fromEntries(
      prepared.map((item) => [item.id, [...item.stratumKeys]])
    ),
    frozenPredictions: Object.fromEntries(
      prepared.map((item) => [item.id, item.routerCandidate])
    ),
  };
}

function validateProtocol(protocol: PmxtRouterLabelingProtocol): void {
  const [mediumStart, highStart] = protocol.confidenceBands;
  if (
    !protocol.protocolVersion.trim() ||
    !Number.isFinite(Date.parse(protocol.frozenAt)) ||
    !Number.isInteger(protocol.minimumSampleSize) ||
    protocol.minimumSampleSize < 1 ||
    !Number.isFinite(mediumStart) ||
    !Number.isFinite(highStart) ||
    mediumStart < 0 ||
    highStart > 1 ||
    mediumStart >= highStart
  ) {
    throw new Error("Invalid PMXT Router labeling protocol");
  }
}

function candidateStrata(
  candidate: PmxtRouterLabelingCandidate,
  confidenceBands: readonly [number, number]
): PmxtRouterFrozenStrata {
  return {
    source: candidateSource(candidate),
    relation: candidate.routerRelation ?? "not_applicable",
    confidence: confidenceBand(candidate.routerConfidence, confidenceBands),
    cryptoThreshold: cryptoThresholdBand(
      candidate.kalshiMarket,
      candidate.polymarketMarket
    ),
    cryptoDeadline: cryptoDeadlineBand(
      candidate.kalshiMarket,
      candidate.polymarketMarket
    ),
    nearMiss: candidate.sameTitleDifferentResolution
      ? "same_title_different_resolution"
      : "none",
  };
}

function candidateSource(candidate: PmxtRouterLabelingCandidate): PmxtRouterCandidateSource {
  if (candidate.sameTitleDifferentResolution) {
    return "near_miss";
  }
  if (candidate.legacyCandidate && candidate.routerCandidate) {
    return "shared";
  }
  if (candidate.legacyCandidate) {
    return "legacy_only";
  }
  if (candidate.routerCandidate) {
    return "router_only";
  }
  throw new Error(
    `Candidate ${candidate.id} must belong to legacy, Router, or near-miss labeling scope`
  );
}

function confidenceBand(
  confidence: number | undefined,
  [mediumStart, highStart]: readonly [number, number]
): PmxtRouterConfidenceBand {
  if (confidence === undefined) return "not_applicable";
  if (confidence >= highStart) return "high";
  if (confidence >= mediumStart) return "medium";
  return "low";
}

function cryptoThresholdBand(
  kalshi: NormalizedMarket,
  polymarket: NormalizedMarket
): PmxtRouterCryptoThresholdBand {
  if (!isCryptoPricePair(kalshi, polymarket)) return "not_crypto";
  if (kalshi.threshold === undefined || polymarket.threshold === undefined) return "missing";
  const difference = Math.abs(kalshi.threshold - polymarket.threshold);
  if (difference < 0.000001) return "exact";
  return difference <= 1 ? "within_one_dollar" : "over_one_dollar";
}

function cryptoDeadlineBand(
  kalshi: NormalizedMarket,
  polymarket: NormalizedMarket
): PmxtRouterCryptoDeadlineBand {
  if (!isCryptoPricePair(kalshi, polymarket)) return "not_crypto";
  if (!kalshi.deadline || !polymarket.deadline) return "missing";
  const kalshiTime = Date.parse(kalshi.deadline);
  const polymarketTime = Date.parse(polymarket.deadline);
  if (!Number.isFinite(kalshiTime) || !Number.isFinite(polymarketTime)) return "missing";
  if (Math.abs(kalshiTime - polymarketTime) <= 60_000) return "within_one_minute";
  const kalshiUtcDay = new Date(kalshiTime).toISOString().slice(0, 10);
  const polymarketUtcDay = new Date(polymarketTime).toISOString().slice(0, 10);
  return kalshiUtcDay === polymarketUtcDay ? "same_utc_day" : "different_utc_day";
}

function isCryptoPricePair(
  kalshi: NormalizedMarket,
  polymarket: NormalizedMarket
): boolean {
  const priceEvent = (market: NormalizedMarket) =>
    market.topic === "crypto" &&
    (market.eventType === "price_above" || market.eventType === "price_below");
  return priceEvent(kalshi) && priceEvent(polymarket);
}
