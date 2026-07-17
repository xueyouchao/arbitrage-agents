import { describe, expect, it } from "vitest";
import { PmxtShadowRunner, isScanIncludedInSample } from "../../src/contexts/scanner/pmxt/pmxt-shadow-runner";
import { InMemoryPmxtShadowLeaseRepository } from "../../src/contexts/scanner/pmxt/in-memory-pmxt-shadow-lease-repository";
import { PmxtShadowRateLimiter } from "../../src/contexts/scanner/pmxt/pmxt-shadow-rate-limiter";
import { AppConfig, loadAppConfig } from "../../src/config/app-config";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = loadAppConfig({
    DATABASE_URL: "postgres://localhost/arbitrage_agents",
    PMXT_API_KEY: "test-key",
    PMXT_HOSTED_BASE_URL: "https://pmxt.example.com",
    PMXT_SHADOW_ENABLED: "true",
    PMXT_SHADOW_READS_ENABLED: "true",
    PMXT_SHADOW_SAMPLE_RATE: "1/1",
    PMXT_SHADOW_MAX_QUEUE_DEPTH: "100",
    PMXT_SHADOW_MAX_QUEUE_WAIT_MS: "30000",
    PMXT_SHADOW_MAX_REQUESTS_PER_RUN: "100",
    PMXT_SHADOW_MAX_MONTHLY_CREDITS: "10000",
    PMXT_SHADOW_MAX_MONTHLY_COST_USD: "10"
  });
  return { ...config, ...overrides };
}

function makeLimiter(config: AppConfig): PmxtShadowRateLimiter {
  return new PmxtShadowRateLimiter({
    requestsPerMinute: config.pmxtShadowRequestsPerMinute,
    maxConcurrency: config.pmxtShadowMaxConcurrency,
    maxRequestsPerRun: config.pmxtShadowMaxRequestsPerRun ?? 0
  });
}

describe("PmxtShadowRunner", () => {
  it("reports disabled when PMXT shadowing is off", async () => {
    const config = baseConfig({ pmxtShadowEnabled: false });
    const repo = new InMemoryPmxtShadowLeaseRepository([]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("disabled");
    expect(result.reason).toBe("PMXT_SHADOW_ENABLED is false");
  });

  it("claims the oldest eligible scan when enabled", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      workerId: "worker-1",
      nextShadowRunId: () => "00000000-0000-4000-8000-00000000aaaa",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("claimed");
    expect(result.authoritativeScanRunId).toBe("00000000-0000-4000-8000-000000000010");
    expect(result.shadowRunId).toBe("00000000-0000-4000-8000-00000000aaaa");
  });

  it("skips when no eligible scan is available", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no eligible unclaimed authoritative scan");
  });

  it("skips when sample rate excludes the scan", async () => {
    const config = baseConfig({ pmxtShadowSampleRate: { numerator: 0, denominator: 1 } });
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("sample_rate_excluded");
  });
});

describe("isScanIncludedInSample", () => {
  it("includes every scan at 1/1", () => {
    const config = baseConfig({ pmxtShadowSampleRate: { numerator: 1, denominator: 1 } });
    expect(isScanIncludedInSample("scan-1", config)).toBe(true);
  });

  it("excludes every scan at 0/1", () => {
    const config = baseConfig({ pmxtShadowSampleRate: { numerator: 0, denominator: 1 } });
    expect(isScanIncludedInSample("scan-1", config)).toBe(false);
  });

  it("is deterministic for the same scan and config", () => {
    const config = baseConfig({ pmxtShadowSampleRate: { numerator: 1, denominator: 2 } });
    const first = isScanIncludedInSample("scan-1", config);
    const second = isScanIncludedInSample("scan-1", config);
    expect(first).toBe(second);
  });
});
