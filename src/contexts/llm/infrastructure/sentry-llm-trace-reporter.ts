// Sentry-backed LLM trace reporter. Each evaluation produces:
//
// 1. A Sentry **span** (`llm.evaluate` / `ai.chat`) with attributes for
//    model, task type, tokens, cost, latency, and cache status. These
//    spans appear in the Sentry Performance trace waterfall, so an
//    operator can see exactly how many LLM calls a scan made and how
//    long each one took.
//
// 2. Sentry **metrics** (counters + distributions) for token usage,
//    cost, and latency — keyed by model tag. Metrics are only emitted
//    for fresh (non-cached) evaluations so that cache hits do not
//    inflate cost dashboards.
//
// When the Sentry SDK is not initialised (no DSN, tests) all calls
// are silently dropped by the SDK — no guard is needed here.

import * as Sentry from "@sentry/node";
import { LlmEvaluationTrace, LlmTraceReporter } from "../application/llm-trace-reporter";

export class SentryLlmTraceReporter implements LlmTraceReporter {
  report(trace: LlmEvaluationTrace): void {
    Sentry.startSpan(
      {
        name: "llm.evaluate",
        op: "ai.chat",
        attributes: {
          "ai.model": trace.model,
          "ai.task_type": trace.taskType,
          "ai.cache_hit": trace.isCacheHit
        }
      },
      (span) => {
        span.setAttribute("ai.prompt_tokens", trace.promptTokens);
        span.setAttribute("ai.completion_tokens", trace.completionTokens);
        span.setAttribute("ai.estimated_cost_usd", trace.estimatedCostUsd);
        span.setAttribute("ai.latency_ms", trace.latencyMs);
        span.setStatus({ code: trace.status === "succeeded" ? 1 : 2 });
      }
    );

    // Skip metrics for cache hits — they have zero real cost and would
    // skew per-scan cost aggregations if counted.
    if (trace.isCacheHit) return;

    const tags = { attributes: { model: trace.model } };
    Sentry.metrics.count("llm.tokens.prompt", trace.promptTokens, tags);
    Sentry.metrics.count("llm.tokens.completion", trace.completionTokens, tags);
    Sentry.metrics.count("llm.cost.usd", trace.estimatedCostUsd, tags);
    Sentry.metrics.distribution("llm.latency.ms", trace.latencyMs, tags);
  }
}
