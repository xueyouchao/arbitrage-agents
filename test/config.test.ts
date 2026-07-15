import { describe, expect, it } from "vitest";
import { loadAppConfig, pmxtShadowConfigForFingerprint } from "../src/config/app-config";
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

  it("defaults PMXT shadow configuration to disabled Free-tier-safe values", () => {
    const config = loadAppConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });

    expect(config).toMatchObject({
      pmxtApiKey: "",
      pmxtHostedBaseUrl: "",
      pmxtShadowEnabled: false,
      pmxtShadowReadsEnabled: false,
      pmxtShadowRouterEnabled: false,
      pmxtShadowSampleRate: { numerator: 0, denominator: 1 },
      pmxtShadowTimeoutMs: 60_000,
      pmxtRequestTimeoutMs: 10_000,
      pmxtShadowRequestsPerMinute: 60,
      pmxtShadowMaxConcurrency: 1,
      pmxtShadowRawRetentionDays: 0
    });
    expect(config.pmxtShadowMaxQueueDepth).toBeUndefined();
    expect(config.pmxtShadowMaxQueueWaitMs).toBeUndefined();
    expect(config.pmxtShadowMaxRequestsPerRun).toBeUndefined();
    expect(config.pmxtShadowMaxMarketsPerVenue).toBeUndefined();
    expect(config.pmxtShadowMaxBooksPerVenue).toBeUndefined();
    expect(config.pmxtShadowMaxMonthlyCredits).toBeUndefined();
    expect(config.pmxtShadowMaxMonthlyCostUsd).toBeUndefined();
  });

  it("parses an explicitly bounded PMXT shadow configuration", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      PMXT_API_KEY: "pmxt_test_secret",
      PMXT_HOSTED_BASE_URL: "https://api.pmxt.dev",
      PMXT_SHADOW_ENABLED: "true",
      PMXT_SHADOW_READS_ENABLED: "true",
      PMXT_SHADOW_SAMPLE_RATE: "1/100",
      PMXT_SHADOW_REQUESTS_PER_MINUTE: "45",
      PMXT_SHADOW_MAX_CONCURRENCY: "1",
      PMXT_SHADOW_MAX_QUEUE_DEPTH: "100",
      PMXT_SHADOW_MAX_QUEUE_WAIT_MS: "30000",
      PMXT_SHADOW_MAX_REQUESTS_PER_RUN: "50",
      PMXT_SHADOW_MAX_MARKETS_PER_VENUE: "20",
      PMXT_SHADOW_MAX_BOOKS_PER_VENUE: "10",
      PMXT_SHADOW_MAX_MONTHLY_CREDITS: "20000",
      PMXT_SHADOW_MAX_MONTHLY_COST_USD: "0",
      PMXT_SHADOW_RAW_RETENTION_DAYS: "7"
    });

    expect(config).toMatchObject({
      pmxtShadowEnabled: true,
      pmxtShadowReadsEnabled: true,
      pmxtShadowRouterEnabled: false,
      pmxtShadowSampleRate: { numerator: 1, denominator: 100 },
      pmxtShadowRequestsPerMinute: 45,
      pmxtShadowMaxConcurrency: 1,
      pmxtShadowMaxQueueDepth: 100,
      pmxtShadowMaxQueueWaitMs: 30_000,
      pmxtShadowMaxRequestsPerRun: 50,
      pmxtShadowMaxMarketsPerVenue: 20,
      pmxtShadowMaxBooksPerVenue: 10,
      pmxtShadowMaxMonthlyCredits: 20_000,
      pmxtShadowMaxMonthlyCostUsd: 0,
      pmxtShadowRawRetentionDays: 7
    });
  });

  it("rejects enabled PMXT shadowing without complete fail-closed bounds", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        PMXT_SHADOW_ENABLED: "true",
        PMXT_SHADOW_READS_ENABLED: "true"
      })
    ).toThrow(/PMXT_API_KEY|PMXT_HOSTED_BASE_URL|PMXT_SHADOW_MAX_QUEUE_DEPTH/);
  });

  it("rejects child PMXT modes when the master switch is disabled", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        PMXT_SHADOW_READS_ENABLED: "true"
      })
    ).toThrow(/PMXT_SHADOW_ENABLED/);
  });

  it("rejects invalid PMXT sample rates and Free-tier queue settings", () => {
    const base = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      PMXT_API_KEY: "pmxt_test_secret",
      PMXT_HOSTED_BASE_URL: "https://api.pmxt.dev",
      PMXT_SHADOW_ENABLED: "true",
      PMXT_SHADOW_READS_ENABLED: "true",
      PMXT_SHADOW_SAMPLE_RATE: "1/100",
      PMXT_SHADOW_MAX_QUEUE_DEPTH: "100",
      PMXT_SHADOW_MAX_QUEUE_WAIT_MS: "30000",
      PMXT_SHADOW_MAX_REQUESTS_PER_RUN: "50",
      PMXT_SHADOW_MAX_MONTHLY_CREDITS: "20000",
      PMXT_SHADOW_MAX_MONTHLY_COST_USD: "0"
    };

    expect(() => loadAppConfig({ ...base, PMXT_SHADOW_SAMPLE_RATE: "2/1" })).toThrow(
      /PMXT_SHADOW_SAMPLE_RATE/
    );
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_SAMPLE_RATE: "999999999999999999999999/999999999999999999999999"
      })
    ).toThrow(/pmxtShadowSampleRate/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_REQUESTS_PER_MINUTE: "61"
      })
    ).toThrow(/pmxtShadowRequestsPerMinute/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_MAX_CONCURRENCY: "0"
      })
    ).toThrow(/pmxtShadowMaxConcurrency/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_MAX_QUEUE_WAIT_MS: "0"
      })
    ).toThrow(/pmxtShadowMaxQueueWaitMs/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_MAX_CONCURRENCY: "2"
      })
    ).toThrow(/pmxtShadowMaxConcurrency/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_HOSTED_BASE_URL: "ftp://api.pmxt.dev"
      })
    ).toThrow(/HTTP or HTTPS/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_HOSTED_BASE_URL: "not-a-url"
      })
    ).toThrow(/PMXT_HOSTED_BASE_URL must be a valid URL|Invalid url/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_HOSTED_BASE_URL: "https://user:password@api.pmxt.dev"
      })
    ).toThrow(/must not contain credentials/);
    expect(() =>
      loadAppConfig({
        ...base,
        PMXT_SHADOW_MAX_MONTHLY_COST_USD: "Infinity"
      })
    ).toThrow(/pmxtShadowMaxMonthlyCostUsd/);
  });

  it("produces PMXT fingerprint input without the API key", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      PMXT_API_KEY: "pmxt_test_secret"
    });

    const fingerprintInput = pmxtShadowConfigForFingerprint(config);
    expect(JSON.stringify(fingerprintInput)).not.toContain("pmxt_test_secret");
    expect(fingerprintInput).not.toHaveProperty("pmxtApiKey");
    expect(fingerprintInput).toHaveProperty("pmxtHostedBaseUrl", "");
    expect(fingerprintInput).toHaveProperty("pmxtShadowRequestsPerMinute", 60);
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

  it("defaults freshness guards to 0 (disabled)", () => {
    const config = loadAppConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });
    expect(config.maxQuoteStalenessMs).toBe(0);
    expect(config.maxOpportunityAgeMs).toBe(0);
  });

  it("coerces freshness guard values from env strings", () => {
    const config = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      MAX_QUOTE_STALENESS_MS: "250",
      MAX_OPPORTUNITY_AGE_MS: "5000"
    });
    expect(config.maxQuoteStalenessMs).toBe(250);
    expect(config.maxOpportunityAgeMs).toBe(5000);
  });

  it("rejects negative freshness guard values", () => {
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        MAX_QUOTE_STALENESS_MS: "-1"
      })
    ).toThrow();
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        MAX_OPPORTUNITY_AGE_MS: "-10"
      })
    ).toThrow();
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
    expect(config.t1ExitEstimatedSlippagePerShare).toBe(0.005);
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
    // Assert the specific zod enum rejection, not just any throw, so a future
    // change that throws for a different reason does not silently pass this test.
    expect(() =>
      loadAppConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        T1_EXIT_POLICY: "always"
      })
    ).toThrow(/T1_EXIT_POLICY|always/);
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
