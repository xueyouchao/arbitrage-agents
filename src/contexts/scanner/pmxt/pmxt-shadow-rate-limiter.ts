// PMXT Shadow Rate Limiter.
//
// Token-bucket rate limiter with concurrency control, queue bounds,
// retry classification, Retry-After handling, and hard request caps.
// Designed for the PMXT shadow read path: it gates every outbound
// request to the PMXT hosted API so the shadow runner never exceeds
// configured limits.
//
// Key behaviors:
//   - Token bucket: refills at `requestsPerMinute` tokens per minute.
//   - Concurrency: at most `maxConcurrency` in-flight requests.
//   - Queue: bounded by `maxQueueDepth`; queued callers wait up to
//     `maxQueueWaitMs` before timing out.
//   - Hard cap: `maxRequestsPerRun` stops the runner after N requests.
//   - Credit/cost: `maxMonthlyCredits` and `maxMonthlyCostUsd` are
//     tracked per-runner lifetime; exhaustion marks the run partial.
//   - Retry classification: 429 (with Retry-After), 5xx, and network
//     errors are retryable; 401/403/402/400 are not.

export interface PmxtShadowRateLimiterConfig {
  requestsPerMinute: number;
  maxConcurrency: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxRequestsPerRun: number;
  maxMonthlyCredits: number;
  maxMonthlyCostUsd: number;
  clock: () => number;
}

export interface PmxtShadowRateLimitResult {
  accepted: boolean;
  reason?: string;
}

export interface PmxtCreditCost {
  credits: number;
  costUsd: number;
}

export interface PmxtRetryClassification {
  retryable: boolean;
  reason?: string;
  retryAfterMs: number;
}

interface QueuedWaiter {
  resolve: (result: PmxtShadowRateLimitResult) => void;
  enqueuedAt: number;
}

const MAX_RETRY_AFTER_MS = 60_000; // 1 minute cap
const DEFAULT_RETRY_AFTER_MS = 1_000;

export class PmxtShadowRateLimiter {
  // Token bucket
  private tokens: number;
  private lastRefill: number;

  // Concurrency
  private inFlight = 0;
  private queue: QueuedWaiter[] = [];

  // Hard caps
  private requestCount = 0;
  private totalCredits = 0;
  private totalCostUsd = 0;

  // Run state
  private runPartial = false;
  private runPartialReason?: string;

  // Timer for queue timeout sweeps
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: PmxtShadowRateLimiterConfig) {
    this.tokens = config.requestsPerMinute;
    this.lastRefill = config.clock();
    this.startQueueSweep();
  }

  async acquire(): Promise<PmxtShadowRateLimitResult> {
    this.refillTokens();

    // Check hard request cap
    if (this.requestCount >= this.config.maxRequestsPerRun) {
      this.markRunPartial("run_cap");
      return { accepted: false, reason: "run_cap" };
    }

    // Check credit/cost exhaustion
    if (this.totalCredits >= this.config.maxMonthlyCredits) {
      this.markRunPartial("credit_exhausted");
      return { accepted: false, reason: "credit_exhausted" };
    }
    if (this.totalCostUsd >= this.config.maxMonthlyCostUsd) {
      this.markRunPartial("cost_exhausted");
      return { accepted: false, reason: "cost_exhausted" };
    }

    // Check rate limit
    if (this.tokens < 1) {
      return { accepted: false, reason: "rate_limit" };
    }

    // Check concurrency
    if (this.inFlight < this.config.maxConcurrency) {
      this.tokens -= 1;
      this.inFlight += 1;
      this.requestCount += 1;
      return { accepted: true };
    }

    // Queue if there's room. When maxQueueDepth is 0, reject immediately
    // with concurrency_limit instead of queue_full.
    if (this.config.maxQueueDepth === 0) {
      return { accepted: false, reason: "concurrency_limit" };
    }
    if (this.queue.length >= this.config.maxQueueDepth) {
      return { accepted: false, reason: "queue_full" };
    }

    return new Promise<PmxtShadowRateLimitResult>((resolve) => {
      this.queue.push({ resolve, enqueuedAt: this.config.clock() });
    });
  }

  release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
    this.drainQueue();
  }

  recordCreditCost(cost: PmxtCreditCost): void {
    this.totalCredits += cost.credits;
    this.totalCostUsd += cost.costUsd;
  }

  consumedCredits(): number {
    return this.totalCredits;
  }

  consumedCostUsd(): number {
    return this.totalCostUsd;
  }

  isCreditExhausted(): boolean {
    return this.totalCredits >= this.config.maxMonthlyCredits;
  }

  isCostExhausted(): boolean {
    return this.totalCostUsd >= this.config.maxMonthlyCostUsd;
  }

  markRunPartial(reason: string): void {
    this.runPartial = true;
    this.runPartialReason = reason;
  }

  isRunPartial(): boolean {
    return this.runPartial;
  }

  partialReason(): string | undefined {
    return this.runPartialReason;
  }

  classifyRetry(
    statusCode: number,
    headers: Record<string, string>
  ): PmxtRetryClassification {
    // Auth failures — never retry
    if (statusCode === 401 || statusCode === 403) {
      return { retryable: false, reason: "auth_failure", retryAfterMs: 0 };
    }

    // Quota exhaustion — never retry
    if (statusCode === 402) {
      return { retryable: false, reason: "quota_exhausted", retryAfterMs: 0 };
    }

    // Client errors (4xx except 429) — not retryable
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      return { retryable: false, reason: "client_error", retryAfterMs: 0 };
    }

    // Rate limit with Retry-After
    if (statusCode === 429) {
      const retryAfterMs = this.parseRetryAfter(headers);
      return { retryable: true, retryAfterMs };
    }

    // Server errors (5xx) — retryable
    if (statusCode >= 500) {
      return { retryable: true, retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }

    // Network errors (status 0) — retryable
    if (statusCode === 0) {
      return { retryable: true, retryAfterMs: DEFAULT_RETRY_AFTER_MS };
    }

    return { retryable: false, reason: "unknown", retryAfterMs: 0 };
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    // Reject all queued waiters
    for (const waiter of this.queue) {
      waiter.resolve({ accepted: false, reason: "disposed" });
    }
    this.queue = [];
  }

  private refillTokens(): void {
    const now = this.config.clock();
    const elapsedMs = now - this.lastRefill;
    const tokensToAdd = (elapsedMs / 60_000) * this.config.requestsPerMinute;
    if (tokensToAdd > 0) {
      this.tokens = Math.min(
        this.config.requestsPerMinute,
        this.tokens + tokensToAdd
      );
      this.lastRefill = now;
    }
  }

  private drainQueue(): void {
    this.refillTokens();
    while (
      this.queue.length > 0 &&
      this.inFlight < this.config.maxConcurrency &&
      this.tokens >= 1
    ) {
      const waiter = this.queue.shift()!;
      this.tokens -= 1;
      this.inFlight += 1;
      this.requestCount += 1;
      waiter.resolve({ accepted: true });
    }
  }

  private startQueueSweep(): void {
    // Sweep the queue every 100ms to time out waiters that exceed maxQueueWaitMs
    this.sweepTimer = setInterval(() => {
      const now = this.config.clock();
      let i = 0;
      while (i < this.queue.length) {
        const waiter = this.queue[i];
        if (now - waiter.enqueuedAt >= this.config.maxQueueWaitMs) {
          this.queue.splice(i, 1);
          waiter.resolve({ accepted: false, reason: "queue_timeout" });
        } else {
          i++;
        }
      }
    }, 100);
  }

  private parseRetryAfter(headers: Record<string, string>): number {
    const raw = headers["retry-after"];
    if (!raw) return DEFAULT_RETRY_AFTER_MS;

    // Try seconds
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }

    // Try HTTP-date
    const date = new Date(raw).getTime();
    if (Number.isFinite(date)) {
      const delay = date - this.config.clock();
      if (delay > 0) {
        return Math.min(delay, MAX_RETRY_AFTER_MS);
      }
    }

    return DEFAULT_RETRY_AFTER_MS;
  }
}
