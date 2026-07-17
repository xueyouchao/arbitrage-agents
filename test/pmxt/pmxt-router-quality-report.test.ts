import { describe, expect, it } from "vitest";
import {
  reportPmxtRouterMatchingQuality,
  PmxtRouterQualityObservation,
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

  it("rejects observations that are not assigned to frozen strata", () => {
    expect(() =>
      reportPmxtRouterMatchingQuality(
        {
          protocolVersion: "router-quality-v1",
          confidenceLevel: 0.95,
          minimumSampleSize: 1,
          eligibleCounts: { "source=shared": 1 },
        },
        [observation("unknown", ["source=router_only"], true, "identity")]
      )
    ).toThrow("not in the frozen cohort");
  });
});
