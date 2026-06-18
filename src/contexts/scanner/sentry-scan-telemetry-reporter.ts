// Sentry-backed scan telemetry reporter. Covers four observability
// signals that the scanner emits but Sentry did not previously see:
//
// 1. **Opportunity detection** — each detected arbitrage opportunity
//    produces a Sentry `captureMessage("info")` with net edge, size,
//    and risk flags. Configure a Sentry Alert on this message to get
//    real-time arb notifications.
//
// 2. **Scan pipeline metrics** — after each scan, gauge/counter
//    metrics are emitted: markets scanned, opportunities found, LLM
//    evaluations, duration, and failure count. These power Sentry
//    dashboards for business-level scan health.
//
// 3. **Venue API health** — each venue fetch produces a Sentry span
//    (`venue.fetch`) with market count and latency. Failed fetches
//    additionally emit a `venue.fetch.errors` counter. Latency
//    distributions are recorded for all fetches so p95 is visible.
//
// 4. **Data staleness** — when stale orderbook snapshots are detected
//    (above zero), a Sentry `captureMessage("warning")` is emitted
//    with the stale count and max staleness so operators can act
//    before trading on bad prices.
//
// When Sentry is not initialised, all calls are silently dropped.

import * as Sentry from "@sentry/node";

export interface OpportunityTrace {
  equivalenceClass: string;
  netEdge: number;
  grossEdge: number;
  executableSizeUsd: number;
  fillRisk: string;
  liquidityRisk: string;
  dataStalenessMs: number;
}

export interface ScanMetricsTrace {
  status: "succeeded" | "failed";
  marketsScanned: number;
  normalizedMarkets: number;
  candidatePairs: number;
  opportunitiesFound: number;
  llmEvaluations: number;
  durationMs: number;
}

export interface VenueFetchTrace {
  venue: string;
  latencyMs: number;
  success: boolean;
  marketCount: number;
}

export interface StaleDataTrace {
  staleCount: number;
  totalMarkets: number;
  maxStalenessMs: number;
}

export interface ScanTelemetryReporter {
  reportOpportunity(trace: OpportunityTrace): void;
  reportScanMetrics(trace: ScanMetricsTrace): void;
  reportVenueFetch(trace: VenueFetchTrace): void;
  reportStaleData(trace: StaleDataTrace): void;
}

export class SentryScanTelemetryReporter implements ScanTelemetryReporter {
  reportOpportunity(trace: OpportunityTrace): void {
    Sentry.withScope((scope) => {
      scope.setTag("equivalence_class", trace.equivalenceClass);
      scope.setTag("fill_risk", trace.fillRisk);
      scope.setTag("liquidity_risk", trace.liquidityRisk);
      scope.setTag("net_edge_pct", (trace.netEdge * 100).toFixed(2));
      scope.setTag("gross_edge_pct", (trace.grossEdge * 100).toFixed(2));
      scope.setTag("executable_size_usd", trace.executableSizeUsd.toFixed(0));
      scope.setTag("data_staleness_ms", String(trace.dataStalenessMs));
      Sentry.captureMessage(
        `Arbitrage opportunity detected [${trace.equivalenceClass}] netEdge=${(trace.netEdge * 100).toFixed(2)}% size=$${trace.executableSizeUsd.toFixed(0)}`,
        "info"
      );
    });
  }

  reportScanMetrics(trace: ScanMetricsTrace): void {
    Sentry.metrics.gauge("scan.markets_scanned", trace.marketsScanned);
    Sentry.metrics.gauge("scan.normalized_markets", trace.normalizedMarkets);
    Sentry.metrics.gauge("scan.candidate_pairs", trace.candidatePairs);
    Sentry.metrics.gauge("scan.opportunities_found", trace.opportunitiesFound);
    Sentry.metrics.count("scan.llm_evaluations", trace.llmEvaluations);
    Sentry.metrics.distribution("scan.duration_ms", trace.durationMs);

    if (trace.status === "failed") {
      Sentry.metrics.count("scan.failure", 1);
    }
  }

  reportVenueFetch(trace: VenueFetchTrace): void {
    Sentry.startSpan(
      {
        name: "venue.fetch",
        op: "http.client",
        attributes: {
          "venue.name": trace.venue,
          "venue.success": trace.success
        }
      },
      (span) => {
        span.setAttribute("venue.market_count", trace.marketCount);
        span.setAttribute("venue.latency_ms", trace.latencyMs);
        span.setStatus({ code: trace.success ? 1 : 2 });
      }
    );

    const tags = { attributes: { venue: trace.venue } };
    Sentry.metrics.distribution("venue.fetch.ms", trace.latencyMs, tags);

    if (!trace.success) {
      Sentry.metrics.count("venue.fetch.errors", 1, tags);
    }
  }

  reportStaleData(trace: StaleDataTrace): void {
    if (trace.staleCount === 0) return;

    Sentry.captureMessage(
      `Stale orderbook data: ${trace.staleCount}/${trace.totalMarkets} markets (max staleness ${trace.maxStalenessMs}ms)`,
      "warning"
    );
  }
}
