import { describe, expect, it, vi } from "vitest";
import { PmxtShadowRunner, PmxtShadowAdmissionResult, isScanIncludedInSample } from "../../src/contexts/scanner/pmxt/pmxt-shadow-runner";
import { InMemoryPmxtShadowLeaseRepository } from "../../src/contexts/scanner/pmxt/in-memory-pmxt-shadow-lease-repository";
import { PmxtShadowRateLimiter } from "../../src/contexts/scanner/pmxt/pmxt-shadow-rate-limiter";
import { PmxtShadowRun } from "../../src/contexts/scanner/pmxt/pmxt-shadow-run";
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

function makeShadowRun(config: AppConfig): PmxtShadowRun {
  return new PmxtShadowRun({
    rateLimiter: makeLimiter(config),
    fetchOrderBooks: vi.fn().mockResolvedValue({}),
    persistRawBook: vi.fn(),
    persistMappedBook: vi.fn(),
    compareBooks: vi.fn().mockReturnValue([]),
    requestTimeoutMs: 10_000,
    maxMarketsPerVenue: 50,
    maxBooksPerVenue: 50,
    maxRetries: 2,
    clock: () => Date.now(),
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
      shadowRun: makeShadowRun(config),
      fetchAuthoritativeMarkets: vi.fn().mockResolvedValue([]),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("disabled");
    expect(result.reason).toBe("PMXT_SHADOW_ENABLED is false");
  });

  it("claims the oldest eligible scan and executes the shadow run", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const fetchAuthoritativeMarkets = vi.fn().mockResolvedValue([]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      shadowRun: makeShadowRun(config),
      fetchAuthoritativeMarkets,
      workerId: "worker-1",
      nextShadowRunId: () => "00000000-0000-4000-8000-00000000aaaa",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("claimed");
    expect(result.authoritativeScanRunId).toBe("00000000-0000-4000-8000-000000000010");
    expect(result.shadowRunId).toBe("00000000-0000-4000-8000-00000000aaaa");
    expect(fetchAuthoritativeMarkets).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000010"
    );
    expect((await repo.listAttempts(result.authoritativeScanRunId!))[0].status).toBe("completed");
  });

  it("skips when no eligible scan is available", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([]);
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      shadowRun: makeShadowRun(config),
      fetchAuthoritativeMarkets: vi.fn().mockResolvedValue([]),
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
      shadowRun: makeShadowRun(config),
      fetchAuthoritativeMarkets: vi.fn().mockResolvedValue([]),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("sample_rate_excluded");
    const attempts = await repo.listAttempts(result.authoritativeScanRunId!);
    expect(attempts[0].status).toBe("sample_excluded");
  });

  it.each([
    { runStatus: "partial", expectedStatus: "partial" },
    { runStatus: "failed", expectedStatus: "failed" }
  ] as const)("durably finalizes a $runStatus shadow result", async ({ runStatus, expectedStatus }) => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const shadowRun = makeShadowRun(config);
    vi.spyOn(shadowRun, "execute").mockResolvedValue({
      status: runStatus,
      reason: "retries_exhausted",
      books: [],
      comparisons: [],
      receiptTimestamp: "2026-07-15T12:00:00.000Z",
      requestCount: 1
    });
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      shadowRun,
      fetchAuthoritativeMarkets: vi.fn().mockResolvedValue([]),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    const attempts = await repo.listAttempts(result.authoritativeScanRunId!);
    expect(attempts[0]).toMatchObject({ status: expectedStatus, retryReason: "retries_exhausted" });
  });

  it("durably finalizes a production run result from the claimed identity", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const runClaimedShadow = vi.fn().mockResolvedValue({
      status: "partial",
      reason: "reads: scope_unproven",
      tracks: {
        reads: { status: "completed" },
        router: { status: "not_requested" },
      },
    });
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      productionRun: { runClaimedShadow },
      workerId: "worker-1",
      nextShadowRunId: () => "00000000-0000-4000-8000-00000000aaaa",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(runClaimedShadow).toHaveBeenCalledWith({
      authoritativeScanRunId: "00000000-0000-4000-8000-000000000010",
      shadowRunId: "00000000-0000-4000-8000-00000000aaaa",
      shadowRunAttemptId: expect.any(String),
    });
    const attempts = await repo.listAttempts(result.authoritativeScanRunId!);
    expect(attempts[0]).toMatchObject({ status: "partial", retryReason: "reads: scope_unproven" });
  });

  it("marks the claimed attempt failed when execution throws and returns failed admission", async () => {
    const config = baseConfig();
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "00000000-0000-4000-8000-000000000010", completedAt: "2026-07-15T10:00:00Z" }
    ]);
    const shadowRun = makeShadowRun(config);
    vi.spyOn(shadowRun, "execute").mockRejectedValue(new Error("boom"));
    const runner = new PmxtShadowRunner({
      config,
      leaseRepository: repo,
      rateLimiter: makeLimiter(config),
      shadowRun,
      fetchAuthoritativeMarkets: vi.fn().mockResolvedValue([]),
      workerId: "worker-1",
      clock: () => "2026-07-15T12:00:00.000Z"
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("boom");

    const attempts = await repo.listAttempts("00000000-0000-4000-8000-000000000010");
    expect(attempts[0]).toMatchObject({ status: "failed", retryReason: "boom" });
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
