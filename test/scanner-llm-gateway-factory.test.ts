// Regression test for issue #54: the SCANNER_LLM_GATEWAY factory must not
// block NestJS dependency resolution while waiting for the LLM endpoint
// ping. Previously the factory was `async` and `await`ed `provider.ping()`,
// blocking startup (and Docker healthchecks) for up to 5000 ms when the
// endpoint was slow or unreachable.
import { describe, expect, it, vi } from "vitest";
import { createScannerLlmGateway } from "../src/contexts/scanner/scanner.module";
import { OllamaChatLlmProvider } from "../src/contexts/llm/infrastructure/ollama-chat-llm-provider";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import type { AppConfig } from "../src/config/app-config";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    databaseUrl: "postgres://localhost/test",
    logLevel: "info",
    sentryDsn: undefined,
    sentrySendDefaultPii: false,
    sentryTracesSampleRate: 0,
    llmPromptSampleRate: 0,
    llmEnabled: true,
    llmProvider: "ollama",
    llmBaseUrl: "http://127.0.0.1:11434/api/chat",
    llmModel: "test-model",
    llmRequestTimeoutMs: 5000,
    scannerLlmPromptVersion: "scanner-v1",
    scannerLlmMaxEvaluationsPerScan: 25,
    scannerAbandonedAfterMs: 300_000,
    sentryMonitorSlug: "arbitrage-agents-scan",
    ...overrides
  } as AppConfig;
}

describe("createScannerLlmGateway (issue #54 — async LLM ping)", () => {
  it("returns undefined when LLM is disabled", () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const config = makeConfig({ llmEnabled: false });

    const gateway = createScannerLlmGateway(repository, config);

    expect(gateway).toBeUndefined();
  });

  it("returns the gateway immediately even when ping would hang", () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const config = makeConfig();

    // fetchImpl that never resolves — simulates a hung LLM endpoint.
    const hangingFetch = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "test-model",
      timeoutMs: 30_000,
      fetchImpl: hangingFetch
    });

    const start = Date.now();
    const gateway = createScannerLlmGateway(repository, config, provider);
    const elapsed = Date.now() - start;

    // The gateway must be constructed and returned synchronously, without
    // waiting for the ping to resolve. If the factory were still async /
    // awaiting the ping, elapsed would be >= the 30s timeout (or 5s for
    // ping's internal cap).
    expect(gateway).toBeDefined();
    expect(elapsed).toBeLessThan(500);

    // The ping fetch was kicked off (fire-and-forget) but did not block
    // the return.
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it("still performs the ping and logs a warning when the endpoint is unreachable", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const config = makeConfig();

    const fetchImpl = vi.fn(async () =>
      new Response("connection refused", { status: 502 })
    ) as typeof fetch;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "test-model",
      timeoutMs: 1000,
      fetchImpl
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const gateway = createScannerLlmGateway(repository, config, provider);
    expect(gateway).toBeDefined();

    // Wait for the fire-and-forget ping to complete.
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Endpoint unreachable")
      );
    });

    // The success log should NOT have been called.
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Endpoint reachable")
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("logs success when the endpoint is reachable", async () => {
    const repository = new InMemoryLlmEvaluationRepository();
    const config = makeConfig();

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    ) as typeof fetch;
    const provider = new OllamaChatLlmProvider({
      baseUrl: "http://127.0.0.1:11434/api/chat",
      model: "test-model",
      timeoutMs: 1000,
      fetchImpl
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const gateway = createScannerLlmGateway(repository, config, provider);
    expect(gateway).toBeDefined();

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Endpoint reachable")
      );
    });

    // The unreachable warning should NOT have been called (for the ping result).
    // Note: a pricing warning may still be logged for "test-model".
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Endpoint unreachable")
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
