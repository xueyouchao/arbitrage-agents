import { describe, expect, it } from "vitest";
import {
  freezeObservationProtocol,
  evaluateObservationWindow,
  type ObservationProtocolInput,
  type ObservationWindowEvidence,
  type PmxtDecisionMemo,
  type DecisionMemoGate,
  type DecisionOutcome,
  type WindowGateStatus,
} from "../../src/contexts/scanner/pmxt/pmxt-observation-window";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validProtocolInput(overrides: Partial<ObservationProtocolInput> = {}): ObservationProtocolInput {
  return {
    protocolVersion: "observation-v1",
    frozenAt: "2026-01-01T00:00:00.000Z",
    confidenceLevel: 0.95,
    minimumSuccessfulRuns: 100,
    minimumDurationDays: 14,
    activityStrata: ["active", "quiet"],
    perStratumMinimumSamples: { active: 50, quiet: 30 },
    retryPolicy: { maxRetries: 2, partialTreatment: "exclude" },
    exclusionReasons: ["stale_book", "mapping_failure", "rate_limited", "timeout"],
    missingDataRule: "mark_inconclusive",
    tolerances: {
      topOfBookTickDeviation: 0.01,
      executableSizeDeviationPct: 0.05,
    },
    confidenceIntervalMethod: "wilson",
    configFingerprint: "sha256:abc123",
    mapperVersion: "mapper-v1",
    domainVersion: "domain-v1",
    promptVersion: "scanner-v1",
    modelVersion: "glm-5.2:cloud",
    sampleRate: { numerator: 1, denominator: 1 },
    ...overrides,
  };
}

function validEvidence(overrides: Partial<ObservationWindowEvidence> = {}): ObservationWindowEvidence {
  return {
    windowStartedAt: "2026-01-01T00:00:00.000Z",
    windowEndedAt: "2026-01-15T00:00:00.000Z",
    successfulRuns: 105,
    failedRuns: 3,
    partialRuns: 2,
    timedOutRuns: 1,
    retriedRuns: 4,
    activityPeriods: [
      { stratum: "active", periods: 10 },
      { stratum: "quiet", periods: 8 },
    ],
    perStratumSamples: { active: 55, quiet: 32 },
    perStratumExclusions: { active: 2, quiet: 1 },
    perStratumExclusionBreakdown: {
      active: { stale_book: 1, mapping_failure: 1 },
      quiet: { timeout: 1 },
    },
    coverageOverlapPct: 96.5,
    topOfBookWithinTickPct: 95.2,
    shadowCompletionRate: 99.1,
    routerPrecision: 98.5,
    routerRecall: 92.0,
    routerLabeledPairs: 210,
    routerFalsePositives: 3,
    incrementalValidCandidates: 12,
    incrementalExecutableOpportunities: 8,
    totalExecutableValueUsd: 1250.0,
    incrementalExecutableValueUsd: 340.0,
    estimatedMonthlyCostUsd: 45.0,
    projectedMonthlyCredits: 5000,
    reliability: {
      meanShadowRuntimeMs: 4500,
      p95ShadowRuntimeMs: 12000,
      meanRequestsPerRun: 18,
      rateLimitHits: 2,
      circuitBreakerTrips: 0,
    },
    safetyIncidents: [],
    configFingerprintUnchanged: true,
    protocolUnchanged: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// freezeObservationProtocol
// ---------------------------------------------------------------------------

describe("freezeObservationProtocol", () => {
  it("freezes all protocol fields and produces an immutable snapshot", () => {
    const input = validProtocolInput();
    const frozen = freezeObservationProtocol(input);

    expect(frozen.protocolVersion).toBe("observation-v1");
    expect(frozen.confidenceLevel).toBe(0.95);
    expect(frozen.minimumSuccessfulRuns).toBe(100);
    expect(frozen.minimumDurationDays).toBe(14);
    expect(frozen.activityStrata).toEqual(["active", "quiet"]);
    expect(frozen.perStratumMinimumSamples).toEqual({ active: 50, quiet: 30 });
    expect(frozen.retryPolicy).toEqual({ maxRetries: 2, partialTreatment: "exclude" });
    expect(frozen.exclusionReasons).toEqual([
      "stale_book", "mapping_failure", "rate_limited", "timeout",
    ]);
    expect(frozen.missingDataRule).toBe("mark_inconclusive");
    expect(frozen.tolerances).toEqual({
      topOfBookTickDeviation: 0.01,
      executableSizeDeviationPct: 0.05,
    });
    expect(frozen.confidenceIntervalMethod).toBe("wilson");
    expect(frozen.configFingerprint).toBe("sha256:abc123");
    expect(frozen.mapperVersion).toBe("mapper-v1");
    expect(frozen.domainVersion).toBe("domain-v1");
    expect(frozen.promptVersion).toBe("scanner-v1");
    expect(frozen.modelVersion).toBe("glm-5.2:cloud");
    expect(frozen.sampleRate).toEqual({ numerator: 1, denominator: 1 });
  });

  it("rejects empty protocol version", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ protocolVersion: "" })))
      .toThrow("protocol version");
  });

  it("rejects invalid confidence level", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ confidenceLevel: 0 })))
      .toThrow("confidence level");
    expect(() => freezeObservationProtocol(validProtocolInput({ confidenceLevel: 1 })))
      .toThrow("confidence level");
    expect(() => freezeObservationProtocol(validProtocolInput({ confidenceLevel: Number.NaN })))
      .toThrow("confidence level");
  });

  it("rejects non-positive minimum run count or duration", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ minimumSuccessfulRuns: 0 })))
      .toThrow("minimum successful runs");
    expect(() => freezeObservationProtocol(validProtocolInput({ minimumDurationDays: 0 })))
      .toThrow("minimum duration");
  });

  it("rejects empty activity strata", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ activityStrata: [] })))
      .toThrow("activity strata");
  });

  it("rejects per-stratum minimum samples that do not cover all strata", () => {
    expect(() =>
      freezeObservationProtocol(
        validProtocolInput({ perStratumMinimumSamples: { active: 50 } })
      )
    ).toThrow("per-stratum minimum samples");
  });

  it("rejects non-positive per-stratum minimum sample", () => {
    expect(() =>
      freezeObservationProtocol(
        validProtocolInput({ perStratumMinimumSamples: { active: 0, quiet: 30 } })
      )
    ).toThrow("per-stratum minimum samples");
  });

  it("rejects negative max retries", () => {
    expect(() =>
      freezeObservationProtocol(
        validProtocolInput({ retryPolicy: { maxRetries: -1, partialTreatment: "exclude" } })
      )
    ).toThrow("retry policy");
  });

  it("rejects empty exclusion reasons", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ exclusionReasons: [] })))
      .toThrow("exclusion reasons");
  });

  it("rejects unknown confidence interval method", () => {
    expect(() =>
      freezeObservationProtocol(validProtocolInput({ confidenceIntervalMethod: "bootstrap" as never }))
    ).toThrow("confidence interval method");
  });

  it("rejects empty config fingerprint", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ configFingerprint: "" })))
      .toThrow("config fingerprint");
  });

  it("rejects empty version strings", () => {
    expect(() => freezeObservationProtocol(validProtocolInput({ mapperVersion: "" })))
      .toThrow("mapper version");
    expect(() => freezeObservationProtocol(validProtocolInput({ domainVersion: "" })))
      .toThrow("domain version");
    expect(() => freezeObservationProtocol(validProtocolInput({ promptVersion: "" })))
      .toThrow("prompt version");
    expect(() => freezeObservationProtocol(validProtocolInput({ modelVersion: "" })))
      .toThrow("model version");
  });
});

// ---------------------------------------------------------------------------
// evaluateObservationWindow — gate checking
// ---------------------------------------------------------------------------

describe("evaluateObservationWindow", () => {
  it("marks all gates as passed when evidence meets the frozen protocol", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.duration).toBe("passed");
    expect(result.gates.runCount).toBe("passed");
    expect(result.gates.activityMix).toBe("passed");
    expect(result.gates.perStratumSamples.active).toBe("passed");
    expect(result.gates.perStratumSamples.quiet).toBe("passed");
    expect(result.gates.protocolIntegrity).toBe("passed");
    expect(result.gates.configIntegrity).toBe("passed");
    expect(result.windowComplete).toBe(true);
  });

  it("fails duration gate when window is too short", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      windowStartedAt: "2026-01-01T00:00:00.000Z",
      windowEndedAt: "2026-01-10T00:00:00.000Z", // 9 days < 14
    });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.duration).toBe("failed");
    expect(result.windowComplete).toBe(false);
  });

  it("fails run-count gate when not enough successful runs", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ successfulRuns: 50 });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.runCount).toBe("failed");
    expect(result.windowComplete).toBe(false);
  });

  it("fails activity-mix gate when a stratum has zero periods", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      activityPeriods: [
        { stratum: "active", periods: 10 },
        { stratum: "quiet", periods: 0 },
      ],
    });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.activityMix).toBe("failed");
    expect(result.windowComplete).toBe(false);
  });

  it("marks under-sampled stratum as inconclusive, not failed", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      perStratumSamples: { active: 55, quiet: 20 }, // quiet < 30
    });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.perStratumSamples.quiet).toBe("inconclusive");
    expect(result.gates.perStratumSamples.active).toBe("passed");
    expect(result.windowComplete).toBe(false);
  });

  it("fails protocol integrity gate when protocol was changed mid-window", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ protocolUnchanged: false });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.protocolIntegrity).toBe("failed");
    expect(result.windowComplete).toBe(false);
  });

  it("fails config integrity gate when fingerprint changed mid-window", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ configFingerprintUnchanged: false });

    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.configIntegrity).toBe("failed");
    expect(result.windowComplete).toBe(false);
  });

  it("rejects evidence with a stratum not in the frozen protocol", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      perStratumSamples: { active: 55, quiet: 32, unknown: 10 },
    });

    expect(() => evaluateObservationWindow(protocol, evidence)).toThrow("unknown stratum");
  });

  it("rejects evidence missing a frozen stratum", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      perStratumSamples: { active: 55 }, // missing quiet
    });

    expect(() => evaluateObservationWindow(protocol, evidence)).toThrow("missing stratum");
  });
});

// ---------------------------------------------------------------------------
// Decision memo — gate reporting
// ---------------------------------------------------------------------------

describe("decision memo gate reporting", () => {
  it("reports every gate with status, threshold, and observed value", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();
    const result = evaluateObservationWindow(protocol, evidence);
    const memo = result.decisionMemo;

    expect(memo.gates).toHaveLength(7);
    const gateNames = memo.gates.map((g) => g.name);
    expect(gateNames).toContain("duration");
    expect(gateNames).toContain("run_count");
    expect(gateNames).toContain("activity_mix");
    expect(gateNames).toContain("per_stratum_samples");
    expect(gateNames).toContain("protocol_integrity");
    expect(gateNames).toContain("config_integrity");
    expect(gateNames).toContain("safety");

    for (const gate of memo.gates) {
      expect(gate.status).toMatch(/^(passed|failed|inconclusive)$/);
      expect(typeof gate.threshold).toBe("string");
      expect(typeof gate.observed).toBe("string");
    }
  });

  it("reports eligible counts, exclusions, and per-stratum breakdown", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.eligibleCounts).toEqual({ active: 55, quiet: 32 });
    expect(memo.exclusions).toEqual({ active: 2, quiet: 1 });
    expect(memo.exclusionBreakdown).toEqual({
      active: { stale_book: 1, mapping_failure: 1 },
      quiet: { timeout: 1 },
    });
  });

  it("reports point estimates with confidence intervals", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.pointEstimates).toBeDefined();
    expect(memo.pointEstimates.coverageOverlapPct).toBe(96.5);
    expect(memo.pointEstimates.topOfBookWithinTickPct).toBe(95.2);
    expect(memo.pointEstimates.routerPrecision).toBe(98.5);
    expect(memo.confidenceIntervals).toBeDefined();
    expect(memo.confidenceIntervals.routerPrecision).toBeDefined();
    expect(memo.confidenceIntervals.routerPrecision?.confidenceLevel).toBe(0.95);
    expect(memo.confidenceIntervals.routerPrecision?.lower).toBeLessThanOrEqual(98.5);
    expect(memo.confidenceIntervals.routerPrecision?.upper).toBeGreaterThanOrEqual(98.5);
  });

  it("reports costs and reliability", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.costs).toEqual({
      estimatedMonthlyCostUsd: 45.0,
      projectedMonthlyCredits: 5000,
      totalExecutableValueUsd: 1250.0,
      incrementalExecutableValueUsd: 340.0,
    });
    expect(memo.reliability).toEqual({
      meanShadowRuntimeMs: 4500,
      p95ShadowRuntimeMs: 12000,
      meanRequestsPerRun: 18,
      rateLimitHits: 2,
      circuitBreakerTrips: 0,
    });
  });

  it("reports limitations including under-sampled strata", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      perStratumSamples: { active: 55, quiet: 20 },
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.limitations).toContain("quiet stratum is inconclusive (20 < 30 eligible)");
  });

  it("reports safety incidents when present", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      safetyIncidents: ["yes_no_inversion_detected"],
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.limitations).toContain("safety incident: yes_no_inversion_detected");
    const safetyGate = memo.gates.find((g) => g.name === "safety");
    expect(safetyGate?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Decision memo — outcome selection
// ---------------------------------------------------------------------------

describe("decision memo outcome selection", () => {
  it("selects outcome F (reject) when safety incidents exist", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ safetyIncidents: ["yes_no_inversion_detected"] });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("F");
    expect(memo.recommendation).toContain("reject");
  });

  it("selects outcome F when protocol integrity is broken", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ protocolUnchanged: false });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("F");
  });

  it("selects inconclusive outcome when strata are under-sampled", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      perStratumSamples: { active: 55, quiet: 20 },
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("inconclusive");
    expect(memo.recommendation).toContain("extend");
  });

  it("selects inconclusive when window not complete", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ successfulRuns: 50 });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("inconclusive");
  });

  it("selects outcome A when reads do not pass but router adds value and passes gates", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 90.0, // below 95% — keep direct reads
      topOfBookWithinTickPct: 90.0,
      shadowCompletionRate: 99.5,
      routerPrecision: 99.0,
      routerRecall: 92.0,
      routerLabeledPairs: 210,
      routerFalsePositives: 2,
      incrementalValidCandidates: 15,
      incrementalExecutableOpportunities: 10,
      incrementalExecutableValueUsd: 500.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("A");
  });

  it("selects outcome B when reads pass but router does not add value", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 97.0,
      topOfBookWithinTickPct: 96.0,
      shadowCompletionRate: 99.5,
      routerPrecision: 70.0,
      routerRecall: 50.0,
      routerLabeledPairs: 210,
      routerFalsePositives: 63,
      incrementalValidCandidates: 0,
      incrementalExecutableOpportunities: 0,
      incrementalExecutableValueUsd: 0.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("B");
  });

  it("selects outcome C when both reads and router independently pass", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 97.0,
      topOfBookWithinTickPct: 96.0,
      shadowCompletionRate: 99.5,
      routerPrecision: 99.0,
      routerRecall: 92.0,
      routerLabeledPairs: 210,
      routerFalsePositives: 2,
      incrementalValidCandidates: 15,
      incrementalExecutableOpportunities: 10,
      incrementalExecutableValueUsd: 500.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("C");
  });

  it("selects outcome D when reads partially pass and router partially passes", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 93.0, // below 95% read overlap gate
      topOfBookWithinTickPct: 96.0,
      shadowCompletionRate: 99.5,
      routerPrecision: 97.0, // below 98% precision gate
      routerRecall: 92.0,
      routerLabeledPairs: 210,
      routerFalsePositives: 6,
      incrementalValidCandidates: 10,
      incrementalExecutableOpportunities: 5,
      incrementalExecutableValueUsd: 200.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("D");
  });

  it("selects outcome F when reads fail and router fails", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 80.0,
      topOfBookWithinTickPct: 70.0,
      shadowCompletionRate: 85.0,
      routerPrecision: 50.0,
      routerRecall: 30.0,
      routerLabeledPairs: 210,
      routerFalsePositives: 105,
      incrementalValidCandidates: 0,
      incrementalExecutableOpportunities: 0,
      incrementalExecutableValueUsd: 0.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("F");
  });
});

// ---------------------------------------------------------------------------
// Cutover prohibition
// ---------------------------------------------------------------------------

describe("cutover prohibition", () => {
  it("includes cutover prohibition for outcomes that recommend adoption", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({
      coverageOverlapPct: 90.0, // reads fail → outcome A
      routerPrecision: 99.0,
      routerFalsePositives: 2,
      incrementalValidCandidates: 15,
      incrementalExecutableOpportunities: 10,
      incrementalExecutableValueUsd: 500.0,
    });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(["A", "B", "C", "D", "E"]).toContain(memo.outcome);
    expect(memo.cutoverRequired).toBe(true);
    expect(memo.cutoverNote).toContain("separate cutover architecture");
    expect(memo.cutoverNote).toContain("rollback plan");
  });

  it("does not require cutover for reject outcome", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ safetyIncidents: ["yes_no_inversion_detected"] });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("F");
    expect(memo.cutoverRequired).toBe(false);
  });

  it("does not require cutover for inconclusive outcome", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ successfulRuns: 50 });
    const memo = evaluateObservationWindow(protocol, evidence).decisionMemo;

    expect(memo.outcome).toBe("inconclusive");
    expect(memo.cutoverRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cohort / window invalidation
// ---------------------------------------------------------------------------

describe("cohort/window invalidation", () => {
  it("detects that a config fingerprint change invalidates the window", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ configFingerprintUnchanged: false });
    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.configIntegrity).toBe("failed");
    expect(result.requiresNewWindow).toBe(true);
  });

  it("detects that a protocol change invalidates the window", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence({ protocolUnchanged: false });
    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.gates.protocolIntegrity).toBe("failed");
    expect(result.requiresNewWindow).toBe(true);
  });

  it("does not require a new window when integrity is intact", () => {
    const protocol = freezeObservationProtocol(validProtocolInput());
    const evidence = validEvidence();
    const result = evaluateObservationWindow(protocol, evidence);

    expect(result.requiresNewWindow).toBe(false);
  });
});
