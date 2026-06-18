import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => {
  return {
    withScope: vi.fn((callback: (scope: { setTag: (key: string, value: string) => void }) => void) => {
      const fakeScope = { setTag: vi.fn() };
      callback(fakeScope);
      return fakeScope;
    }),
    startSpan: vi.fn((_options: unknown, callback: (span: unknown) => void) => {
      const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
      callback(fakeSpan);
      return fakeSpan;
    }),
    captureMessage: vi.fn(),
    metrics: {
      count: vi.fn(),
      distribution: vi.fn(),
      gauge: vi.fn()
    }
  };
});

import * as Sentry from "@sentry/node";
import { SentryScanTelemetryReporter } from "../src/contexts/scanner/sentry-scan-telemetry-reporter";

describe("SentryScanTelemetryReporter — opportunity detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a Sentry event when an opportunity is detected", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportOpportunity({
      equivalenceClass: "A",
      netEdge: 0.05,
      grossEdge: 0.08,
      executableSizeUsd: 500,
      fillRisk: "low",
      liquidityRisk: "medium",
      dataStalenessMs: 1200
    });

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = (Sentry.captureMessage as any).mock.calls[0];
    expect(message).toContain("Arbitrage opportunity detected");
    expect(level).toBe("info");
  });

  it("sets opportunity details as Sentry scope tags via withScope", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportOpportunity({
      equivalenceClass: "A",
      netEdge: 0.05,
      grossEdge: 0.08,
      executableSizeUsd: 500,
      fillRisk: "low",
      liquidityRisk: "medium",
      dataStalenessMs: 1200
    });

    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    const scopeCallback = (Sentry.withScope as any).mock.calls[0][0];
    const fakeScope = { setTag: vi.fn() };
    scopeCallback(fakeScope);

    expect(fakeScope.setTag).toHaveBeenCalledWith("equivalence_class", "A");
    expect(fakeScope.setTag).toHaveBeenCalledWith("fill_risk", "low");
    expect(fakeScope.setTag).toHaveBeenCalledWith("liquidity_risk", "medium");
    expect(fakeScope.setTag).toHaveBeenCalledWith("net_edge_pct", expect.any(String));
    expect(fakeScope.setTag).toHaveBeenCalledWith("data_staleness_ms", "1200");
  });
});

describe("SentryScanTelemetryReporter — scan pipeline metrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits Sentry metrics for scan results", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportScanMetrics({
      status: "succeeded",
      marketsScanned: 120,
      normalizedMarkets: 80,
      candidatePairs: 45,
      opportunitiesFound: 3,
      llmEvaluations: 10,
      durationMs: 4500
    });

    expect(Sentry.metrics.gauge).toHaveBeenCalledWith("scan.markets_scanned", 120);
    expect(Sentry.metrics.gauge).toHaveBeenCalledWith("scan.opportunities_found", 3);
    expect(Sentry.metrics.count).toHaveBeenCalledWith("scan.llm_evaluations", 10);
    expect(Sentry.metrics.distribution).toHaveBeenCalledWith("scan.duration_ms", 4500);
  });

  it("emits a failure counter when scan fails", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportScanMetrics({
      status: "failed",
      marketsScanned: 0,
      normalizedMarkets: 0,
      candidatePairs: 0,
      opportunitiesFound: 0,
      llmEvaluations: 0,
      durationMs: 1000
    });

    expect(Sentry.metrics.count).toHaveBeenCalledWith("scan.failure", 1);
  });

  it("does not emit failure counter on success", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportScanMetrics({
      status: "succeeded",
      marketsScanned: 50,
      normalizedMarkets: 30,
      candidatePairs: 10,
      opportunitiesFound: 1,
      llmEvaluations: 5,
      durationMs: 3000
    });

    const failureCalls = (Sentry.metrics.count as any).mock.calls.filter(
      (call: any[]) => call[0] === "scan.failure"
    );
    expect(failureCalls).toHaveLength(0);
  });
});

describe("SentryScanTelemetryReporter — venue API health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a Sentry span for each venue fetch", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportVenueFetch({ venue: "kalshi", latencyMs: 350, success: true, marketCount: 42 });

    expect(Sentry.startSpan).toHaveBeenCalledTimes(1);
    const spanOpts = (Sentry.startSpan as any).mock.calls[0][0];
    expect(spanOpts.name).toBe("venue.fetch");
    expect(spanOpts.op).toBe("http.client");
    expect(spanOpts.attributes).toMatchObject({
      "venue.name": "kalshi",
      "venue.success": true
    });
  });

  it("sets market count and latency on the span", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportVenueFetch({ venue: "polymarket", latencyMs: 800, success: true, marketCount: 65 });

    const spanCallback = (Sentry.startSpan as any).mock.calls[0][1];
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    spanCallback(fakeSpan);

    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("venue.market_count", 65);
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("venue.latency_ms", 800);
  });

  it("emits error metric and latency distribution on failed fetch", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportVenueFetch({ venue: "kalshi", latencyMs: 5000, success: false, marketCount: 0 });

    expect(Sentry.metrics.count).toHaveBeenCalledWith("venue.fetch.errors", 1, {
      attributes: { venue: "kalshi" }
    });
    expect(Sentry.metrics.distribution).toHaveBeenCalledWith("venue.fetch.ms", 5000, {
      attributes: { venue: "kalshi" }
    });
  });

  it("emits latency distribution on successful fetch too", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportVenueFetch({ venue: "polymarket", latencyMs: 200, success: true, marketCount: 50 });

    expect(Sentry.metrics.distribution).toHaveBeenCalledWith("venue.fetch.ms", 200, {
      attributes: { venue: "polymarket" }
    });
  });
});

describe("SentryScanTelemetryReporter — data staleness alerts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a Sentry warning when stale markets are detected", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportStaleData({ staleCount: 5, totalMarkets: 80, maxStalenessMs: 90_000 });

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = (Sentry.captureMessage as any).mock.calls[0];
    expect(message).toContain("Stale orderbook data");
    expect(level).toBe("warning");
  });

  it("does not emit a warning when no markets are stale", () => {
    const reporter = new SentryScanTelemetryReporter();

    reporter.reportStaleData({ staleCount: 0, totalMarkets: 80, maxStalenessMs: 0 });

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
