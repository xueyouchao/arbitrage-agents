import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  PmxtShadowRateLimiter,
  PmxtShadowRateLimiterConfig,
  PmxtShadowRateLimitResult,
} from "../../src/contexts/scanner/pmxt/pmxt-shadow-rate-limiter";

function config(overrides: Partial<PmxtShadowRateLimiterConfig> = {}): PmxtShadowRateLimiterConfig {
  return {
    requestsPerMinute: 60,
    maxConcurrency: 1,
    maxQueueDepth: 100,
    maxQueueWaitMs: 30_000,
    maxRequestsPerRun: 1000,
    maxMonthlyCredits: 10_000,
    maxMonthlyCostUsd: 100,
    clock: () => Date.now(),
    ...overrides,
  };
}

describe("PMXT shadow rate limiter", () => {
  let limiter: PmxtShadowRateLimiter;

  beforeEach(() => {
    limiter = new PmxtShadowRateLimiter(config());
  });

  afterEach(() => {
    limiter.dispose();
  });

  describe("concurrency control", () => {
    it("allows a request when under max concurrency", async () => {
      const result = await limiter.acquire();
      expect(result.accepted).toBe(true);
      limiter.release();
    });

    it("rejects a request when at max concurrency with no queue", async () => {
      const cfg = config({ maxConcurrency: 1, maxQueueDepth: 0 });
      const l = new PmxtShadowRateLimiter(cfg);
      await l.acquire(); // occupy the slot
      const result = await l.acquire();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("concurrency_limit");
      l.release();
      l.dispose();
    });

    it("queues a request when at max concurrency and queue has room", async () => {
      const cfg = config({ maxConcurrency: 1, maxQueueDepth: 5 });
      const l = new PmxtShadowRateLimiter(cfg);
      const first = await l.acquire(); // occupy the slot
      expect(first.accepted).toBe(true);

      // Queue the second — it should resolve when the first releases
      const secondPromise = l.acquire();
      // Release after a tick
      setTimeout(() => l.release(), 5);
      const second = await secondPromise;
      expect(second.accepted).toBe(true);
      l.release();
      l.dispose();
    });

    it("rejects a request when queue is full", async () => {
      const cfg = config({ maxConcurrency: 1, maxQueueDepth: 1 });
      const l = new PmxtShadowRateLimiter(cfg);
      await l.acquire(); // occupy slot
      void l.acquire(); // occupy queue (don't await, it will pend)
      // Third request should be rejected immediately
      const result = await l.acquire();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("queue_full");
      l.release();
      l.release();
      l.dispose();
    });
  });

  describe("queue wait timeout", () => {
    it("rejects a queued request that exceeds max queue wait time", async () => {
      const cfg = config({ maxConcurrency: 1, maxQueueDepth: 5, maxQueueWaitMs: 10 });
      const l = new PmxtShadowRateLimiter(cfg);
      await l.acquire(); // occupy slot
      // This should time out after 10ms
      const result = await l.acquire();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("queue_timeout");
      l.release();
      l.dispose();
    });
  });

  describe("rate limiting", () => {
    it("allows requests up to the per-minute limit", async () => {
      const cfg = config({ requestsPerMinute: 3, maxConcurrency: 3, maxQueueDepth: 0 });
      const l = new PmxtShadowRateLimiter(cfg);
      for (let i = 0; i < 3; i++) {
        const result = await l.acquire();
        expect(result.accepted).toBe(true);
      }
      // Fourth should be rate-limited
      const result = await l.acquire();
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("rate_limit");
      for (let i = 0; i < 3; i++) l.release();
      l.dispose();
    });

    it("refills tokens over time", async () => {
      let now = 0;
      const cfg = config({
        requestsPerMinute: 60,
        maxConcurrency: 60,
        maxQueueDepth: 0,
        clock: () => now,
      });
      const l = new PmxtShadowRateLimiter(cfg);
      // Exhaust the bucket
      for (let i = 0; i < 60; i++) {
        const result = await l.acquire();
        expect(result.accepted).toBe(true);
      }
      // Release all so concurrency doesn't block the next check
      for (let i = 0; i < 60; i++) l.release();

      // Next should be rate-limited (tokens exhausted)
      const rejected = await l.acquire();
      expect(rejected.accepted).toBe(false);
      expect(rejected.reason).toBe("rate_limit");

      // Advance time by 1 second (1 token refilled at 60/min)
      now += 1000;
      const accepted = await l.acquire();
      expect(accepted.accepted).toBe(true);

      l.release();
      l.dispose();
    });
  });

  describe("hard request cap", () => {
    it("rejects requests once the per-run cap is reached", async () => {
      const cfg = config({ maxRequestsPerRun: 2, maxConcurrency: 2, maxQueueDepth: 0 });
      const l = new PmxtShadowRateLimiter(cfg);
      const r1 = await l.acquire();
      expect(r1.accepted).toBe(true);
      const r2 = await l.acquire();
      expect(r2.accepted).toBe(true);
      const r3 = await l.acquire();
      expect(r3.accepted).toBe(false);
      expect(r3.reason).toBe("run_cap");
      l.release();
      l.release();
      l.dispose();
    });
  });

  describe("credit and cost tracking", () => {
    it("tracks consumed credits", () => {
      limiter.recordCreditCost({ credits: 5, costUsd: 0.01 });
      expect(limiter.consumedCredits()).toBe(5);
      expect(limiter.consumedCostUsd()).toBe(0.01);
    });

    it("rejects when monthly credit cap is exceeded", () => {
      const l = new PmxtShadowRateLimiter(config({ maxMonthlyCredits: 10 }));
      l.recordCreditCost({ credits: 9, costUsd: 0.01 });
      expect(l.isCreditExhausted()).toBe(false);
      l.recordCreditCost({ credits: 2, costUsd: 0.01 });
      expect(l.isCreditExhausted()).toBe(true);
      l.dispose();
    });

    it("rejects when monthly cost cap is exceeded", () => {
      const l = new PmxtShadowRateLimiter(config({ maxMonthlyCostUsd: 1 }));
      l.recordCreditCost({ credits: 1, costUsd: 0.99 });
      expect(l.isCostExhausted()).toBe(false);
      l.recordCreditCost({ credits: 1, costUsd: 0.02 });
      expect(l.isCostExhausted()).toBe(true);
      l.dispose();
    });
  });

  describe("retry classification", () => {
    it("classifies 429 with Retry-After as retryable", () => {
      const classification = limiter.classifyRetry(429, { "retry-after": "5" });
      expect(classification.retryable).toBe(true);
      expect(classification.retryAfterMs).toBe(5000);
    });

    it("classifies 429 without Retry-After as retryable with default delay", () => {
      const classification = limiter.classifyRetry(429, {});
      expect(classification.retryable).toBe(true);
      expect(classification.retryAfterMs).toBeGreaterThan(0);
    });

    it("classifies 503 as retryable", () => {
      const classification = limiter.classifyRetry(503, {});
      expect(classification.retryable).toBe(true);
    });

    it("classifies network errors as retryable", () => {
      const classification = limiter.classifyRetry(0, {});
      expect(classification.retryable).toBe(true);
    });

    it("classifies 401 as non-retryable", () => {
      const classification = limiter.classifyRetry(401, {});
      expect(classification.retryable).toBe(false);
      expect(classification.reason).toBe("auth_failure");
    });

    it("classifies 403 as non-retryable", () => {
      const classification = limiter.classifyRetry(403, {});
      expect(classification.retryable).toBe(false);
      expect(classification.reason).toBe("auth_failure");
    });

    it("classifies monthly quota exhaustion (402-like) as non-retryable", () => {
      const classification = limiter.classifyRetry(402, {});
      expect(classification.retryable).toBe(false);
      expect(classification.reason).toBe("quota_exhausted");
    });

    it("classifies 400 as non-retryable", () => {
      const classification = limiter.classifyRetry(400, {});
      expect(classification.retryable).toBe(false);
      expect(classification.reason).toBe("client_error");
    });

    it("classifies 500 as retryable", () => {
      const classification = limiter.classifyRetry(500, {});
      expect(classification.retryable).toBe(true);
    });
  });

  describe("run state", () => {
    it("reports partial run when hard cap is reached", () => {
      const l = new PmxtShadowRateLimiter(config({ maxRequestsPerRun: 1, maxConcurrency: 1, maxQueueDepth: 0 }));
      expect(l.isRunPartial()).toBe(false);
      l.markRunPartial("run_cap");
      expect(l.isRunPartial()).toBe(true);
      expect(l.partialReason()).toBe("run_cap");
      l.dispose();
    });

    it("reports partial run when credit is exhausted", () => {
      const l = new PmxtShadowRateLimiter(config({ maxMonthlyCredits: 1 }));
      l.recordCreditCost({ credits: 2, costUsd: 0.01 });
      l.markRunPartial("credit_exhausted");
      expect(l.isRunPartial()).toBe(true);
      expect(l.partialReason()).toBe("credit_exhausted");
      l.dispose();
    });
  });

  describe("Retry-After header parsing", () => {
    it("parses Retry-After in seconds", () => {
      const classification = limiter.classifyRetry(429, { "retry-after": "30" });
      expect(classification.retryAfterMs).toBe(30_000);
    });

    it("parses Retry-After as HTTP-date", () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const classification = limiter.classifyRetry(429, { "retry-after": future });
      expect(classification.retryAfterMs).toBeGreaterThan(55_000);
      expect(classification.retryAfterMs).toBeLessThanOrEqual(65_000);
    });

    it("uses default delay when Retry-After is absent", () => {
      const classification = limiter.classifyRetry(429, {});
      expect(classification.retryAfterMs).toBe(1000);
    });

    it("caps Retry-After at a maximum", () => {
      const classification = limiter.classifyRetry(429, { "retry-after": "999999" });
      expect(classification.retryAfterMs).toBeLessThanOrEqual(60_000);
    });
  });
});
