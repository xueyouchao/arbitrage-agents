import { describe, expect, it } from "vitest";
import { PmxtShadowRateLimiter } from "../../src/contexts/scanner/pmxt/pmxt-shadow-rate-limiter";

function makeLimiter(options: Partial<ConstructorParameters<typeof PmxtShadowRateLimiter>[0]> = {}) {
  let now = 0;
  const limiter = new PmxtShadowRateLimiter({
    requestsPerMinute: 60,
    maxConcurrency: 1,
    maxRequestsPerRun: 5,
    clock: () => now,
    ...options
  });
  return { limiter, tick: (ms: number) => { now += ms; } };
}

describe("PmxtShadowRateLimiter", () => {
  it("allows the first request up to the burst capacity", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 2, requestsPerMinute: 60_000 });
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(0).allowed).toBe(false);
  });

  it("refills tokens over time", () => {
    const { limiter, tick } = makeLimiter({ maxConcurrency: 2, requestsPerMinute: 60 });
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(0).allowed).toBe(false);
    limiter.release();
    limiter.release();
    tick(1000);
    expect(limiter.allowRequest(0).allowed).toBe(true);
  });

  it("enforces the per-run request budget", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 2, requestsPerMinute: 60_000, maxRequestsPerRun: 2 });
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(1).allowed).toBe(true);
    const result = limiter.allowRequest(2);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("run_request_budget_exhausted");
  });

  it("applies a global cooldown on 429", () => {
    const { limiter, tick } = makeLimiter({ maxConcurrency: 1, requestsPerMinute: 60_000 });
    limiter.reportFailure(429);
    expect(limiter.allowRequest(0).allowed).toBe(false);
    expect(limiter.allowRequest(0).reason).toBe("global_cooldown");
    tick(1000);
    expect(limiter.allowRequest(0).allowed).toBe(true);
  });

  it("opens the circuit breaker after repeated 429s", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 1, requestsPerMinute: 60_000 });
    limiter.reportFailure(429);
    limiter.reportFailure(429);
    const result = limiter.allowRequest(0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("circuit_open");
  });

  it("does not retry auth failures", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 1, requestsPerMinute: 60_000 });
    limiter.reportFailure(401);
    expect(limiter.allowRequest(0).allowed).toBe(true);
  });

  it("does not open the circuit on 5xx", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 1, requestsPerMinute: 60_000 });
    limiter.reportFailure(500);
    expect(limiter.allowRequest(0).allowed).toBe(true);
  });

  it("releases concurrency slots when requests complete", () => {
    const { limiter } = makeLimiter({ maxConcurrency: 1, requestsPerMinute: 60_000 });
    expect(limiter.allowRequest(0).allowed).toBe(true);
    expect(limiter.allowRequest(0).allowed).toBe(false);
    limiter.release();
    expect(limiter.allowRequest(0).allowed).toBe(true);
  });
});
