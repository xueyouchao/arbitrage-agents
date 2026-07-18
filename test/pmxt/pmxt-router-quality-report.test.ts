import { describe, expect, it } from "vitest";
import {
  reportPmxtRouterMatchingQuality,
  inverseStandardNormal,
  PmxtRouterQualityObservation,
  inverseStandardNormal,
} from "../../src/contexts/scanner/pmxt/pmxt-router-quality-report";

function observation(
  id: string,
  stratumKeys: string[],
  routerPredictedIdentity: boolean,
  label: "identity" | "not_identity" | "inconclusive"
): PmxtRouterQualityObservation {
  return { id, stratumKeys, routerPredictedIdentity, label };
}

describe("reportPmxtRouterMatchingQuality", () => {
  it("reports precision, recall, and false positives by frozen stratum", () => {
    const report = reportPmxtRouterMatchingQuality(
      {
        protocolVersion: "router-quality-v1",
        confidenceLevel: 0.95,
        minimumSampleSize: 2,
        eligibleCounts: {
          "source=shared": 4,
          "confidence=high": 3,
        },
      },
      [
        observation("tp", ["source=shared", "confidence=high"], true, "identity"),
        observation("fp", ["source=shared", "confidence=high"], true, "not_identity"),
        observation("fn", ["source=shared"], false, "identity"),
        observation("tn", ["source=shared"], false, "not_identity"),
      ]
    );

    expect(report.strata["source=shared"]).toMatchObject({
      eligibleCount: 4,
      selectedCount: 4,
      labeledCount: 4,
      routerPredictedPositiveCount: 2,
      positiveLabelCount: 2,
      truePositiveCount: 1,
      falsePositiveCount: 1,
      falseNegativeCount: 1,
      precision: 0.5,
      recall: 0.5,
      falsePositiveRate: 0.5,
      status: "conclusive",
    });
    expect(report.strata["source=shared"].precisionInterval).toMatchObject({
      confidenceLevel: 0.95,
    });
    expect(report.strata["source=shared"].precisionInterval?.lower).toBeCloseTo(
      0.0945,
      3
    );
    expect(report.strata["source=shared"].precisionInterval?.upper).toBeCloseTo(
      0.9055,
      3
    );
    expect(report.strata["confidence=high"]).toMatchObject({
      eligibleCount: 3,
      selectedCount: 2,
      labeledCount: 2,
      precision: 0.5,
      recall: 1,
      status: "inconclusive",
      inconclusiveReasons: [
        "insufficient_recall_sample",
        "insufficient_false_positive_sample",
      ],
    });
  });

  it("marks insufficient samples and zero denominators as inconclusive", () => {
    const report = reportPmxtRouterMatchingQuality(
      {
        protocolVersion: "router-quality-v1",
        confidenceLevel: 0.95,
        minimumSampleSize: 3,
        eligibleCounts: {
          "source=router_only": 10,
          "relation=subset": 5,
        },
      },
      [
        observation("one", ["source=router_only"], true, "identity"),
        observation("two", ["source=router_only"], true, "inconclusive"),
        observation("three", ["relation=subset"], false, "not_identity"),
      ]
    );

    expect(report.strata["source=router_only"]).toMatchObject({
      eligibleCount: 10,
      selectedCount: 2,
      labeledCount: 1,
      precision: 1,
      recall: 1,
      status: "inconclusive",
      inconclusiveReasons: [
        "insufficient_labeled_sample",
        "insufficient_precision_sample",
        "insufficient_recall_sample",
        "zero_false_positive_denominator",
      ],
    });
    expect(report.strata["relation=subset"]).toMatchObject({
      eligibleCount: 5,
      selectedCount: 1,
      labeledCount: 1,
      precision: undefined,
      recall: undefined,
      falsePositiveRate: 0,
      status: "inconclusive",
      inconclusiveReasons: [
        "insufficient_labeled_sample",
        "zero_precision_denominator",
        "zero_recall_denominator",
        "insufficient_false_positive_sample",
      ],
    });
  });

  it("marks each metric inconclusive when its effective sample is insufficient", () => {
    const report = reportPmxtRouterMatchingQuality(
      {
        protocolVersion: "router-quality-v1",
        confidenceLevel: 0.95,
        minimumSampleSize: 3,
        eligibleCounts: { "source=shared": 4 },
      },
      [
        observation("tp-1", ["source=shared"], true, "identity"),
        observation("tp-2", ["source=shared"], true, "identity"),
        observation("fn", ["source=shared"], false, "identity"),
        observation("tn", ["source=shared"], false, "not_identity"),
      ]
    );

    expect(report.strata["source=shared"]).toMatchObject({
      status: "inconclusive",
      inconclusiveReasons: [
        "insufficient_precision_sample",
        "insufficient_false_positive_sample",
      ],
    });
  });

  it("rejects duplicate observations and repeated stratum membership", () => {
    const protocol = {
      protocolVersion: "router-quality-v1",
      confidenceLevel: 0.95,
      minimumSampleSize: 1,
      eligibleCounts: { "source=shared": 1 },
    };

    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("same", ["source=shared"], true, "identity"),
        observation("same", ["source=shared"], true, "identity"),
      ])
    ).toThrow("Duplicate observation same");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("same", ["source=shared", "source=shared"], true, "identity"),
      ])
    ).toThrow("repeats stratum source=shared");
  });

  it("rejects observations that do not match frozen cohort membership", () => {
    const protocol = {
      protocolVersion: "router-quality-v1",
      confidenceLevel: 0.95,
      minimumSampleSize: 1,
      eligibleCounts: { "source=shared": 1 },
      frozenMembership: { known: ["source=shared"] },
      frozenPredictions: { known: true },
    };

    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("unknown", ["source=shared"], true, "identity"),
      ])
    ).toThrow("is not in the frozen cohort");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("known", ["source=router_only"], true, "identity"),
      ])
    ).toThrow("does not match frozen strata");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("known", ["source=shared", "extra=stratum"], true, "identity"),
      ])
    ).toThrow("does not match frozen strata");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("known", ["source=shared"], false, "identity"),
      ])
    ).toThrow("does not match frozen Router prediction");
  });

  it("rejects invalid observations and inconsistent eligible counts", () => {
    const validProtocol = {
      protocolVersion: "router-quality-v1",
      confidenceLevel: 0.95,
      minimumSampleSize: 1,
      eligibleCounts: { "source=shared": 1 },
      frozenMembership: { known: ["source=shared"] },
      frozenPredictions: { known: true },
    };

    expect(() =>
      reportPmxtRouterMatchingQuality(validProtocol, [
        { ...observation("known", ["source=shared"], true, "identity"), label: "bad" as "identity" },
      ])
    ).toThrow("invalid human label");
    expect(() =>
      reportPmxtRouterMatchingQuality(
        { ...validProtocol, eligibleCounts: { "source=shared": 0 } },
        []
      )
    ).toThrow("eligible counts do not match frozen membership");
  });

  it("rejects observations with non-string id, non-array, or empty stratumKeys", () => {
    const protocol = {
      protocolVersion: "router-quality-v1",
      confidenceLevel: 0.95,
      minimumSampleSize: 1,
      eligibleCounts: { "source=shared": 1 },
    };

    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        { id: 123 as unknown as string, stratumKeys: ["source=shared"], routerPredictedIdentity: true, label: "identity" },
      ])
    ).toThrow("PMXT Router observation ID must be a non-empty string");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        { id: "obs", stratumKeys: "not-an-array" as unknown as string[], routerPredictedIdentity: true, label: "identity" },
      ])
    ).toThrow("invalid stratum key");
    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("empty", [], true, "identity"),
      ])
    ).toThrow("invalid stratum key");
  });

  it("rejects when selected count exceeds eligible count without frozen membership", () => {
    const protocol = {
      protocolVersion: "router-quality-v1",
      confidenceLevel: 0.95,
      minimumSampleSize: 1,
      eligibleCounts: { "source=shared": 1 },
    };

    expect(() =>
      reportPmxtRouterMatchingQuality(protocol, [
        observation("a", ["source=shared"], true, "identity"),
        observation("b", ["source=shared"], true, "identity"),
      ])
    ).toThrow("exceeds eligible count");
  });

  it("inverseStandardNormal returns correct sign for extreme probabilities", () => {
    // Low tail: p < 0.02425 returns negative (left side of bell curve)
    expect(inverseStandardNormal(0.001)).toBeLessThan(0);
    expect(inverseStandardNormal(0.01)).toBeLessThan(0);
    expect(inverseStandardNormal(0.024)).toBeLessThan(0);
    // High tail: p > 0.97575 returns positive (right side of bell curve)
    expect(inverseStandardNormal(0.976)).toBeGreaterThan(0);
    expect(inverseStandardNormal(0.99)).toBeGreaterThan(0);
    expect(inverseStandardNormal(0.999)).toBeGreaterThan(0);
    // Mid-range: p < 0.5 negative, p > 0.5 positive, at 0.5 it's 0
    expect(inverseStandardNormal(0.5)).toBeCloseTo(0, 5);
    // p=0.025 is left of center → negative
    expect(inverseStandardNormal(0.025)).toBeLessThan(0);
    // p=0.975 is right of center → positive
    expect(inverseStandardNormal(0.975)).toBeGreaterThan(0);
  });

  it("rejects invalid probability inputs", () => {
    expect(() => inverseStandardNormal(0)).toThrow("requires probability in (0, 1)");
    expect(() => inverseStandardNormal(1)).toThrow("requires probability in (0, 1)");
    expect(() => inverseStandardNormal(-0.5)).toThrow("requires probability in (0, 1)");
    expect(() => inverseStandardNormal(1.5)).toThrow("requires probability in (0, 1)");
    expect(() => inverseStandardNormal(Number.NaN)).toThrow("requires probability in (0, 1)");
    expect(() => inverseStandardNormal(Infinity)).toThrow("requires probability in (0, 1)");
  });

  it("rejects non-finite confidence levels", () => {
    expect(() =>
      reportPmxtRouterMatchingQuality(
        {
          protocolVersion: "router-quality-v1",
          confidenceLevel: Number.NaN,
          minimumSampleSize: 1,
          eligibleCounts: {},
          frozenMembership: {},
          frozenPredictions: {},
        },
        []
      )
    ).toThrow("Invalid PMXT Router quality protocol");
  });
});

describe("inverseStandardNormal", () => {
  it("returns negative for low tail probabilities (p < 0.02425)", () => {
    const z = inverseStandardNormal(0.001);
    expect(z).toBeLessThan(0);
    expect(z).toBeCloseTo(-3.090, 2);
  });

  it("returns positive for high tail probabilities (p > 0.97575)", () => {
    const z = inverseStandardNormal(0.999);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeCloseTo(3.090, 2);
  });

  it("returns zero for p=0.5", () => {
    const z = inverseStandardNormal(0.5);
    expect(z).toBeCloseTo(0, 5);
  });

  it("returns symmetric values for complementary probabilities", () => {
    const zLow = inverseStandardNormal(0.01);
    const zHigh = inverseStandardNormal(0.99);
    expect(zLow).toBeCloseTo(-zHigh, 5);
  });

  it("is antisymmetric around p=0.5", () => {
    const zLeft = inverseStandardNormal(0.2);
    const zRight = inverseStandardNormal(0.8);
    expect(zLeft).toBeCloseTo(-zRight, 5);
  });
});
