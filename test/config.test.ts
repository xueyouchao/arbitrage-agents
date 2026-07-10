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

  it("defaults maxCapitalDeployedUsd to 5000", () => {
    const config = loadAppConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });
    expect(config.maxCapitalDeployedUsd).toBe(5000);
  });

  it("coerces maxCapitalDeployedUsd from env string", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      MAX_CAPITAL_DEPLOYED_USD: "10000"
    });
    expect(config.maxCapitalDeployedUsd).toBe(10000);
  });

  it("defaults ADR-0002 T1 exit-gate parameters", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db"
    });
    expect(config.t1ExitMinMargin).toBe(0.005);
    expect(config.t1ExitDepthHaircut).toBe(0.25);
    expect(config.t1ExitPolicy).toBe("evaluate");
    expect(config.t1ExitGapDecayPerHour).toBe(0.02);
    expect(config.t1ExitGapDecayMax).toBe(0.5);
    expect(config.t1ExitSellFeeRate).toBe(0.01);
    expect(config.t1ExitEstimatedSpreadRate).toBe(0.01);
    expect(config.t1ExitEstimatedSlippageRate).toBe(0.005);
  });

  it("coerces ADR-0002 T1 exit-gate overrides from env strings", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      T1_EXIT_MIN_MARGIN: "0.02",
      T1_EXIT_DEPTH_HAIRCUT: "0.4",
      T1_EXIT_POLICY: "hold",
      T1_EXIT_GAP_DECAY_PER_HOUR: "0.05"
    });
    expect(config.t1ExitMinMargin).toBe(0.02);
    expect(config.t1ExitDepthHaircut).toBe(0.4);
    expect(config.t1ExitPolicy).toBe("hold");
    expect(config.t1ExitGapDecayPerHour).toBe(0.05);
  });

  it("rejects invalid T1 exit policy values", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        T1_EXIT_POLICY: "bogus"
      })
    ).toThrow();
  });

  it("rejects the deferred 'always' unconditional-exit policy", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        T1_EXIT_POLICY: "always"
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
