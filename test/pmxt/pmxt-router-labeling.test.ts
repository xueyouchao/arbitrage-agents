import { describe, expect, it } from "vitest";
import { NormalizedMarket } from "../../src/contexts/matching/domain/normalized-market";
import {
  buildFrozenPmxtRouterLabelingCohort,
  PmxtRouterLabelingCandidate,
} from "../../src/contexts/scanner/pmxt/pmxt-router-labeling";

function market(
  venue: "kalshi" | "polymarket",
  id: string,
  overrides: Partial<NormalizedMarket> = {}
): NormalizedMarket {
  return {
    id: `${venue}:${id}`,
    venue,
    venueMarketId: id,
    title: "Will BTC exceed $100,000?",
    rawResolutionText: "Resolves from the Coinbase BTC/USD price.",
    topic: "crypto",
    eventType: "price_above",
    asset: "BTC",
    threshold: 100_000,
    operator: ">",
    deadline: "2026-12-31T20:00:00.000Z",
    resolutionSource: "coinbase",
    payoffType: "at_time",
    ambiguityFlags: [],
    confidence: 0.95,
    ...overrides,
  };
}

function candidate(
  id: string,
  overrides: Partial<PmxtRouterLabelingCandidate> = {}
): PmxtRouterLabelingCandidate {
  return {
    id,
    kalshiMarket: market("kalshi", `k-${id}`),
    polymarketMarket: market("polymarket", `p-${id}`),
    legacyCandidate: false,
    routerCandidate: false,
    ...overrides,
  };
}

describe("buildFrozenPmxtRouterLabelingCohort", () => {
  it("freezes source, relation, confidence, crypto, and near-miss strata", () => {
    const candidates: PmxtRouterLabelingCandidate[] = [
      candidate("shared", {
        legacyCandidate: true,
        routerCandidate: true,
        routerRelation: "identity",
        routerConfidence: 0.93,
      }),
      candidate("legacy", { legacyCandidate: true }),
      candidate("router", {
        routerCandidate: true,
        routerRelation: "identity",
        routerConfidence: 0.74,
        polymarketMarket: market("polymarket", "p-router", {
          threshold: 100_001,
          deadline: "2026-12-31T23:00:00.000Z",
        }),
      }),
      candidate("near-miss", {
        sameTitleDifferentResolution: true,
        routerRelation: "subset",
        routerConfidence: 0.42,
        polymarketMarket: market("polymarket", "p-near-miss", {
          threshold: 100_002,
          deadline: "2027-01-01T20:00:00.000Z",
          resolutionSource: "kraken",
        }),
      }),
    ];

    const cohort = buildFrozenPmxtRouterLabelingCohort(candidates, {
      protocolVersion: "router-quality-v1",
      frozenAt: "2026-07-17T00:00:00.000Z",
      confidenceBands: [0.5, 0.8],
      minimumSampleSize: 2,
    });

    expect(cohort).toMatchObject({
      protocolVersion: "router-quality-v1",
      frozenAt: "2026-07-17T00:00:00.000Z",
      minimumSampleSize: 2,
    });
    expect(cohort.items.map((item) => item.strata.source)).toEqual([
      "shared",
      "legacy_only",
      "router_only",
      "near_miss",
    ]);
    expect(cohort.items.map((item) => item.strata.relation)).toEqual([
      "identity",
      "not_applicable",
      "identity",
      "subset",
    ]);
    expect(cohort.items.map((item) => item.strata.confidence)).toEqual([
      "high",
      "not_applicable",
      "medium",
      "low",
    ]);
    expect(cohort.items.map((item) => item.strata.cryptoThreshold)).toEqual([
      "exact",
      "exact",
      "within_one_dollar",
      "over_one_dollar",
    ]);
    expect(cohort.items.map((item) => item.strata.cryptoDeadline)).toEqual([
      "within_one_minute",
      "within_one_minute",
      "same_utc_day",
      "different_utc_day",
    ]);
    expect(cohort.items.map((item) => item.strata.nearMiss)).toEqual([
      "none",
      "none",
      "none",
      "same_title_different_resolution",
    ]);
  });

  it("freezes eligible counts for every represented stratum dimension", () => {
    const cohort = buildFrozenPmxtRouterLabelingCohort(
      [
        candidate("shared-a", {
          legacyCandidate: true,
          routerCandidate: true,
          routerRelation: "identity",
          routerConfidence: 0.9,
        }),
        candidate("shared-b", {
          legacyCandidate: true,
          routerCandidate: true,
          routerRelation: "identity",
          routerConfidence: 0.9,
        }),
        candidate("legacy", { legacyCandidate: true }),
      ],
      {
        protocolVersion: "router-quality-v1",
        frozenAt: "2026-07-17T00:00:00.000Z",
        confidenceBands: [0.5, 0.8],
        minimumSampleSize: 2,
      }
    );

    expect(cohort.eligibleCounts).toMatchObject({
      "source=shared": 2,
      "source=legacy_only": 1,
      "relation=identity": 2,
      "relation=not_applicable": 1,
      "confidence=high": 2,
      "confidence=not_applicable": 1,
    });
    expect(cohort.items[0].stratumKeys).toContain("source=shared");
    expect(cohort.items[0].eligibleCounts["source=shared"]).toBe(2);
  });

  it("rejects candidates outside the declared labeling universe", () => {
    expect(() =>
      buildFrozenPmxtRouterLabelingCohort([candidate("orphan")], {
        protocolVersion: "router-quality-v1",
        frozenAt: "2026-07-17T00:00:00.000Z",
        confidenceBands: [0.5, 0.8],
        minimumSampleSize: 2,
      })
    ).toThrow("must belong to legacy, Router, or near-miss labeling scope");
  });
});
