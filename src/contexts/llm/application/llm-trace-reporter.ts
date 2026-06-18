// Trace reporter interface for LLM evaluations. The gateway calls
// `report()` after each evaluation (fresh, cached, or failed) so that
// observability backends (Sentry, Datadog, stdout) can record spans,
// metrics, or logs without the gateway depending on any specific SDK.
//
// Implementations live in infrastructure/ (e.g. SentryLlmTraceReporter).
// Tests and local dev can pass a no-op or recording implementation.

export interface LlmEvaluationTrace {
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  isCacheHit: boolean;
  status: "succeeded" | "failed";
}

export interface LlmTraceReporter {
  report(trace: LlmEvaluationTrace): void;
}
