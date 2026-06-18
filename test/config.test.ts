import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config";
import { redactSensitiveData } from "../src/config/redaction";

describe("loadAppConfig", () => {
  it("validates and coerces environment configuration", () => {
    expect(
      loadAppConfig({
        NODE_ENV: "test",
        PORT: "4000",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        LOG_LEVEL: "debug",
        SENTRY_SEND_DEFAULT_PII: "false",
        LLM_PROMPT_SAMPLE_RATE: "0.25",
        LLM_ENABLED: "true",
        LLM_BASE_URL: "http://127.0.0.1:11434/api/chat",
        LLM_MODEL: "kimi-k2.6:cloud",
        LLM_REQUEST_TIMEOUT_MS: "45000",
        SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN: "7",
        SCANNER_ABANDONED_AFTER_MS: "120000",
        SENTRY_MONITOR_SLUG: "custom-monitor",
        SENTRY_TRACES_SAMPLE_RATE: "0.1"
      })
    ).toMatchObject({
      nodeEnv: "test",
      port: 4000,
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      logLevel: "debug",
      sentrySendDefaultPii: false,
      llmPromptSampleRate: 0.25,
      llmEnabled: true,
      llmBaseUrl: "http://127.0.0.1:11434/api/chat",
      llmModel: "kimi-k2.6:cloud",
      llmRequestTimeoutMs: 45000,
      scannerLlmMaxEvaluationsPerScan: 7,
      scannerAbandonedAfterMs: 120000,
      sentryMonitorSlug: "custom-monitor",
      sentryTracesSampleRate: 0.1
    });
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadAppConfig({
        PORT: "99999",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db"
      })
    ).toThrow();
  });

  it("defaults sentryTracesSampleRate to 0 (tracing disabled)", () => {
    const config = loadAppConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });
    expect(config.sentryTracesSampleRate).toBe(0);
  });

  it("rejects sentryTracesSampleRate outside 0..1", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        SENTRY_TRACES_SAMPLE_RATE: "1.5"
      })
    ).toThrow();
  });
});

describe("redactSensitiveData", () => {
  it("recursively redacts sensitive keys without mutating safe fields", () => {
    expect(
      redactSensitiveData({
        apiKey: "secret",
        nested: { authorization: "bearer token", safe: "visible" },
        list: [{ private_key: "wallet-secret", title: "market" }]
      })
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
      list: [{ private_key: "[REDACTED]", title: "market" }]
    });
  });
});
