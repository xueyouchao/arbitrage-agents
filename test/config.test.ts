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
        SCANNER_LLM_PROMPT_VERSION: "scanner-v2",
        SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN: "7",
        VENUE_HTTP_TIMEOUT_MS: "15000",
        VENUE_HTTP_RETRIES: "4",
        VENUE_HTTP_RETRY_DELAY_MS: "250",
        VENUE_HTTP_VERBOSE: "true"
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
      scannerLlmPromptVersion: "scanner-v2",
      scannerLlmMaxEvaluationsPerScan: 7,
      venueHttpTimeoutMs: 15000,
      venueHttpRetries: 4,
      venueHttpRetryDelayMs: 250,
      venueHttpVerbose: true
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
