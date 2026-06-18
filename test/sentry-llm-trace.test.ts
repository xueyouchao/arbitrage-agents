import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersistedLlmGateway } from "../src/contexts/llm/application/persisted-llm-gateway";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import { LlmCostCalculator } from "../src/contexts/llm/application/llm-cost-calculator";
import type { LlmTraceReporter, LlmEvaluationTrace } from "../src/contexts/llm/application/llm-trace-reporter";

// Mock Sentry so we can assert on span creation without the SDK.
vi.mock("@sentry/node", () => {
  return {
    startSpan: vi.fn((_options: unknown, callback: (span: unknown) => void) => {
      const fakeSpan = {
        setAttribute: vi.fn(),
        setStatus: vi.fn()
      };
      callback(fakeSpan);
      return fakeSpan;
    }),
    metrics: {
      count: vi.fn(),
      distribution: vi.fn()
    }
  };
});

import * as Sentry from "@sentry/node";
import { SentryLlmTraceReporter } from "../src/contexts/llm/infrastructure/sentry-llm-trace-reporter";

describe("SentryLlmTraceReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a Sentry span for each fresh LLM evaluation", () => {
    const reporter = new SentryLlmTraceReporter();

    reporter.report({
      model: "gpt-4o",
      taskType: "market_equivalence",
      promptTokens: 1000,
      completionTokens: 500,
      estimatedCostUsd: 0.0075,
      latencyMs: 120,
      isCacheHit: false,
      status: "succeeded"
    });

    expect(Sentry.startSpan).toHaveBeenCalledTimes(1);
    const spanOpts = (Sentry.startSpan as any).mock.calls[0][0];
    expect(spanOpts.name).toBe("llm.evaluate");
    expect(spanOpts.op).toBe("ai.chat");
    expect(spanOpts.attributes).toMatchObject({
      "ai.model": "gpt-4o",
      "ai.task_type": "market_equivalence",
      "ai.cache_hit": false
    });
  });

  it("sets token, cost, and latency attributes on the span", () => {
    const reporter = new SentryLlmTraceReporter();

    reporter.report({
      model: "gpt-4o",
      taskType: "market_equivalence",
      promptTokens: 1000,
      completionTokens: 500,
      estimatedCostUsd: 0.0075,
      latencyMs: 120,
      isCacheHit: false,
      status: "succeeded"
    });

    // The callback received a fake span; assert attributes were set.
    const spanCallback = (Sentry.startSpan as any).mock.calls[0][1];
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    spanCallback(fakeSpan);

    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("ai.prompt_tokens", 1000);
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("ai.completion_tokens", 500);
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("ai.estimated_cost_usd", 0.0075);
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith("ai.latency_ms", 120);
  });

  it("emits Sentry metrics counters and distributions", () => {
    const reporter = new SentryLlmTraceReporter();

    reporter.report({
      model: "gpt-4o",
      taskType: "market_equivalence",
      promptTokens: 1000,
      completionTokens: 500,
      estimatedCostUsd: 0.0075,
      latencyMs: 120,
      isCacheHit: false,
      status: "succeeded"
    });

    expect(Sentry.metrics.count).toHaveBeenCalledWith("llm.tokens.prompt", 1000, { attributes: { model: "gpt-4o" } });
    expect(Sentry.metrics.count).toHaveBeenCalledWith("llm.tokens.completion", 500, { attributes: { model: "gpt-4o" } });
    expect(Sentry.metrics.count).toHaveBeenCalledWith("llm.cost.usd", 0.0075, { attributes: { model: "gpt-4o" } });
    expect(Sentry.metrics.distribution).toHaveBeenCalledWith("llm.latency.ms", 120, { attributes: { model: "gpt-4o" } });
  });

  it("skips metrics for cache hits so cached calls don't inflate cost dashboards", () => {
    const reporter = new SentryLlmTraceReporter();

    reporter.report({
      model: "gpt-4o",
      taskType: "market_equivalence",
      promptTokens: 1000,
      completionTokens: 500,
      estimatedCostUsd: 0,
      latencyMs: 2,
      isCacheHit: true,
      status: "succeeded"
    });

    // Span is still created (for trace visibility), but metrics are skipped.
    expect(Sentry.startSpan).toHaveBeenCalledTimes(1);
    expect(Sentry.metrics.count).not.toHaveBeenCalled();
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });
});

describe("PersistedLlmGateway + LlmTraceReporter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the trace reporter after each fresh evaluation", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter: LlmTraceReporter = { report: vi.fn() };
    const costCalculator = new LlmCostCalculator({
      "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 }
    });
    const gateway = new PersistedLlmGateway(repository, async () => ({
      output: { equivalent: true, confidence: 0.9, explanation: "same" },
      tokenUsage: { promptTokens: 1000, completionTokens: 500 },
      latencyMs: 120
    }), { costCalculator, traceReporter });

    await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "gpt-4o", input: { a: 1 } });

    expect(traceReporter.report).toHaveBeenCalledTimes(1);
    const trace: LlmEvaluationTrace = (traceReporter.report as any).mock.calls[0][0];
    expect(trace.model).toBe("gpt-4o");
    expect(trace.taskType).toBe("market_equivalence");
    expect(trace.promptTokens).toBe(1000);
    expect(trace.completionTokens).toBe(500);
    expect(trace.estimatedCostUsd).toBeCloseTo(0.0075, 6);
    expect(trace.latencyMs).toBe(120);
    expect(trace.isCacheHit).toBeFalsy();
    expect(trace.status).toBe("succeeded");
  });

  it("reports cache hits so traces show cached vs fresh evaluations", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter: LlmTraceReporter = { report: vi.fn() };
    const gateway = new PersistedLlmGateway(repository, async () => ({
      output: { equivalent: true, confidence: 0.9, explanation: "same" },
      tokenUsage: { promptTokens: 1000, completionTokens: 500 },
      latencyMs: 120
    }), { traceReporter });

    // First call — fresh
    await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });
    // Second call — cache hit
    await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(traceReporter.report).toHaveBeenCalledTimes(2);
    expect((traceReporter.report as any).mock.calls[1][0].isCacheHit).toBe(true);
  });

  it("reports failed evaluations with zero tokens", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter: LlmTraceReporter = { report: vi.fn() };
    const gateway = new PersistedLlmGateway(repository, async () => {
      throw new Error("provider failed");
    }, { traceReporter });

    await gateway.evaluate({ taskType: "explanation", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(traceReporter.report).toHaveBeenCalledTimes(1);
    const trace: LlmEvaluationTrace = (traceReporter.report as any).mock.calls[0][0];
    expect(trace.status).toBe("failed");
    expect(trace.promptTokens).toBe(0);
    expect(trace.completionTokens).toBe(0);
    expect(trace.estimatedCostUsd).toBe(0);
  });
});
