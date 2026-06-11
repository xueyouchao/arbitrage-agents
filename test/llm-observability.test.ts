import { describe, expect, it } from "vitest";
import { PersistedLlmGateway } from "../src/contexts/llm/application/persisted-llm-gateway";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
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
