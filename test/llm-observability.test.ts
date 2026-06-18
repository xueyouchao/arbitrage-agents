import { describe, expect, it } from "vitest";
import { PersistedLlmGateway } from "../src/contexts/llm/application/persisted-llm-gateway";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import { LlmCostCalculator } from "../src/contexts/llm/application/llm-cost-calculator";
import { ObservabilityService } from "../src/contexts/observability/observability.service";

describe("PersistedLlmGateway", () => {
  it("caches by task, prompt version, model, and input hash", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    let calls = 0;
    const gateway = new PersistedLlmGateway(repository, async () => {
      calls += 1;
      return { output: { equivalent: true, confidence: 0.9, explanation: "same event" }, tokenUsage: { promptTokens: 10, completionTokens: 4 }, latencyMs: 25 };
    });

    const first = await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });
    const second = await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(first.status).toBe("succeeded");
    expect(second.id).toBe(first.id);
    expect(calls).toBe(1);
  });

  it("marks malformed task outputs as failed instead of caching them as succeeded", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const gateway = new PersistedLlmGateway(repository, async () => ({ output: { foo: "bar" } }));

    const record = await gateway.evaluate({ taskType: "market_normalization", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(record.status).toBe("failed");
    expect(record.parsedOutput).toBeUndefined();
  });

  it("redacts provider errors before persisting failed evaluations", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const gateway = new PersistedLlmGateway(repository, async () => {
      throw new Error("provider failed https://example.test?api_key=secret Authorization: Bearer token");
    });

    const record = await gateway.evaluate({ taskType: "explanation", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(record.status).toBe("failed");
    expect(record.output).toEqual({ error: "provider failed [redacted-url] Authorization: [REDACTED]" });
    expect(repository.records[0].output).toEqual(record.output);
  });

  it("redacts JSON-shaped provider secrets before persistence", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const gateway = new PersistedLlmGateway(repository, async () => {
      throw new Error('{"api_key":"secret","apiKey":"secret","accessToken":"secret","authorization":"Bearer token","safe":"visible"}');
    });

    const record = await gateway.evaluate({ taskType: "explanation", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(record.output).toEqual({ error: '{"api_key":"[REDACTED]","apiKey":"[REDACTED]","accessToken":"[REDACTED]","authorization":"[REDACTED]","safe":"visible"}' });
  });

  it("computes estimatedCostUsd from tokens when a costCalculator is provided", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const costCalculator = new LlmCostCalculator({
      "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 }
    });
    const gateway = new PersistedLlmGateway(repository, async () => ({
      output: { equivalent: true, confidence: 0.9, explanation: "same event" },
      tokenUsage: { promptTokens: 1_000_000, completionTokens: 500_000 },
      latencyMs: 100
    }), { costCalculator });

    const record = await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "gpt-4o", input: { a: 1 } });

    expect(record.status).toBe("succeeded");
    // 1M prompt × $2.50/1M + 500K completion × $10/1M = $2.50 + $5.00 = $7.50
    expect(record.estimatedCostUsd).toBeCloseTo(7.5, 6);
    // The persisted record must also carry the cost
    expect(repository.records[0].estimatedCostUsd).toBeCloseTo(7.5, 6);
  });

  it("defaults estimatedCostUsd to 0 when no costCalculator is provided", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const gateway = new PersistedLlmGateway(repository, async () => ({
      output: { equivalent: true, confidence: 0.9, explanation: "same" },
      tokenUsage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      latencyMs: 50
    }));

    const record = await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "gpt-4o", input: { a: 1 } });

    expect(record.status).toBe("succeeded");
    expect(record.estimatedCostUsd).toBe(0);
  });

  it("sets estimatedCostUsd to 0 on failed evaluations regardless of costCalculator", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const costCalculator = new LlmCostCalculator({
      "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 }
    });
    const gateway = new PersistedLlmGateway(repository, async () => {
      throw new Error("provider down");
    }, { costCalculator });

    const record = await gateway.evaluate({ taskType: "explanation", promptVersion: "v1", model: "gpt-4o", input: { a: 1 } });

    expect(record.status).toBe("failed");
    expect(record.estimatedCostUsd).toBe(0);
  });

  it("isolates trace reporter failures so a throwing reporter does not lose a persisted evaluation", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter = {
      report: () => { throw new Error("reporter exploded"); }
    };
    const gateway = new PersistedLlmGateway(
      repository,
      async () => ({
        output: { equivalent: true, confidence: 0.9, explanation: "same" },
        tokenUsage: { promptTokens: 10, completionTokens: 4 },
        latencyMs: 25
      }),
      { traceReporter }
    );

    const record = await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });

    // The evaluation must succeed despite the reporter throwing
    expect(record.status).toBe("succeeded");
    expect(repository.records).toHaveLength(1);
  });

  it("isolates trace reporter failures on cache hits so a throwing reporter does not abort the return", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter = { report: () => { /* ok first time */ } };
    const gateway = new PersistedLlmGateway(
      repository,
      async () => ({
        output: { equivalent: true, confidence: 0.9, explanation: "same" },
        tokenUsage: { promptTokens: 10, completionTokens: 4 },
        latencyMs: 25
      }),
      { traceReporter }
    );

    // First call populates the cache
    await gateway.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });

    // Now replace with a throwing reporter
    const throwingReporter = { report: () => { throw new Error("reporter exploded on cache hit"); } };
    const gateway2 = new PersistedLlmGateway(
      repository,
      async () => ({ output: { should: "not be called" } }),
      { traceReporter: throwingReporter }
    );

    const cached = await gateway2.evaluate({ taskType: "market_equivalence", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(cached.status).toBe("succeeded");
    expect(cached.isCacheHit).toBe(true);
  });

  it("isolates trace reporter failures on provider errors so the failed record is still returned", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const traceReporter = {
      report: () => { throw new Error("reporter exploded on failure path"); }
    };
    const gateway = new PersistedLlmGateway(
      repository,
      async () => { throw new Error("provider down"); },
      { traceReporter }
    );

    const record = await gateway.evaluate({ taskType: "explanation", promptVersion: "v1", model: "test", input: { a: 1 } });

    expect(record.status).toBe("failed");
    expect(repository.records).toHaveLength(1);
  });
});

describe("ObservabilityService", () => {
  it("redacts sensitive metadata before capture", () => {
    const service = new ObservabilityService();

    service.captureError(new Error("boom"), { apiKey: "secret", safe: "visible", nested: { authorization: "bearer" } });

    expect(service.capturedEvents[0].metadata).toEqual({
      apiKey: "[REDACTED]",
      safe: "visible",
      nested: { authorization: "[REDACTED]" }
    });
  });
});
