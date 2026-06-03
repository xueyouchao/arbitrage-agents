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
        LLM_PROMPT_SAMPLE_RATE: "0.25"
      })
    ).toMatchObject({
      nodeEnv: "test",
      port: 4000,
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      logLevel: "debug",
      sentrySendDefaultPii: false,
      llmPromptSampleRate: 0.25
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
