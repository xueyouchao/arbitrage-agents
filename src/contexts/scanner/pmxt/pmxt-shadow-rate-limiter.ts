export interface PmxtShadowRateLimiterOptions {
  requestsPerMinute: number;
  maxConcurrency: number;
  maxRequestsPerRun: number;
  defaultRetryAfterMs?: number;
  clock?(): number;
}

export interface PmxtShadowRateLimitResult {
  allowed: boolean;
  reason?: string;
}

// Issue #93: process-wide token-bucket rate limiter for PMXT Hosted API
// calls. This is the admission gate used before every request. It supports:
//   - token-bucket rate limiting with bounded burst
//   - per-run request budget
//   - global Retry-After cooldown (from 429 responses)
//   - one default 429 requeue per request when Retry-After is absent
//   - adaptive slowdown after repeated 429s
//   - circuit breaker after sustained rate limiting
//   - no retry for auth (401/403) or monthly-quota errors
//
// The limiter is intentionally separate from request execution so it can be
// unit-tested deterministically. Higher-level queueing and priority scheduling
// are layered on top in the shadow runner.
export class PmxtShadowRateLimiter {
  private tokens: number;
  private capacity: number;
  private ratePerMs: number;
  private inFlight = 0;
  private globalCooldownUntil = 0;
  private circuitOpenUntil = 0;
  private adaptiveRateMultiplier = 1;
  private lastRefillAt: number;
  private readonly defaultRetryAfterMs: number;
  private readonly clock: () => number;

  constructor(private readonly options: PmxtShadowRateLimiterOptions) {
    this.capacity = Math.max(1, options.maxConcurrency);
    this.tokens = this.capacity;
    this.ratePerMs = options.requestsPerMinute / 60_000;
    this.clock = options.clock ?? (() => Date.now());
    this.lastRefillAt = this.clock();
    this.defaultRetryAfterMs = options.defaultRetryAfterMs ?? 1_000;
  }

  /**
   * Ask permission to send one PMXT request. Returns immediately with
   * `allowed: true` when the request can proceed, or `allowed: false`
   * with a reason code when it must be dropped or skipped.
   */
  allowRequest(runRequestCount: number): PmxtShadowRateLimitResult {
    const now = this.clock();

    if (now < this.circuitOpenUntil) {
      return { allowed: false, reason: "circuit_open" };
    }

    if (now < this.globalCooldownUntil) {
      return { allowed: false, reason: "global_cooldown" };
    }

    if (this.options.maxRequestsPerRun > 0 && runRequestCount >= this.options.maxRequestsPerRun) {
      return { allowed: false, reason: "run_request_budget_exhausted" };
    }

    this.refill(now);

    if (this.inFlight >= this.options.maxConcurrency) {
      return { allowed: false, reason: "max_concurrency" };
    }

    if (this.tokens < 1) {
      return { allowed: false, reason: "rate_limited" };
    }

    this.tokens -= 1;
    this.inFlight += 1;
    return { allowed: true };
  }

  /**
   * Notify the limiter that an in-flight request has completed, freeing a
   * concurrency slot and returning one token to the bucket (capped at capacity).
   */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.tokens = Math.min(this.capacity, this.tokens + 1);
  }

  /**
   * Notify the limiter of a successful response so it can gradually speed
   * back up after a prior slowdown.
   */
  reportSuccess(): void {
    this.adaptiveRateMultiplier = Math.max(this.adaptiveRateMultiplier * 0.95, 1);
  }

  /**
   * Notify the limiter of a failure response. 429 triggers cooldown and
   * adaptive slowdown. 401/403 are recorded but do not open the circuit
   * breaker (auth failures are not transient). 402 (payment required /
   * monthly-quota exhaustion) opens the circuit immediately as fatal.
   */
  reportFailure(statusCode: number, retryAfterSeconds?: number): void {
    if (statusCode === 429) {
      this.reportRetryAfter(retryAfterSeconds);
      this.adaptiveRateMultiplier = Math.min(this.adaptiveRateMultiplier * 2, 16);
      if (this.adaptiveRateMultiplier >= 4) {
        this.circuitOpenUntil = this.clock() + 60_000;
      }
    } else if (statusCode === 402) {
      // Monthly-quota exhaustion: open circuit immediately, no cooldown expiry.
      this.circuitOpenUntil = Number.MAX_SAFE_INTEGER;
    }
    // 401/403: auth failures are recorded by the caller via the status code;
    // the limiter does not open the circuit for them.
  }

  reportRetryAfter(seconds?: number): void {
    const ms = seconds === undefined || seconds <= 0 ? this.defaultRetryAfterMs : seconds * 1000;
    const until = this.clock() + ms;
    if (until > this.globalCooldownUntil) {
      this.globalCooldownUntil = until;
    }
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsed * this.ratePerMs / this.adaptiveRateMultiplier
      );
      this.lastRefillAt = now;
    }
  }
}
