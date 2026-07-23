export type ShadowAttemptStatus =
  | "claimed"
  | "completed"
  | "sample_excluded"
  | "partial"
  | "failed"
  | "exhausted";

export interface ShadowLeaseClaim {
  shadowRunAttemptId: string;
  authoritativeScanRunId: string;
  shadowRunId: string;
  attemptNumber: number;
  claimedAt: string;
  leasedUntil: string;
}

export interface ShadowAttempt extends ShadowLeaseClaim {
  workerId: string;
  status: ShadowAttemptStatus;
  retryReason?: string;
  nextRetryAt?: string;
  maxAttempts: number;
}

export interface FinalizeShadowAttemptOptions {
  shadowRunAttemptId: string;
  workerId: string;
  status: Exclude<ShadowAttemptStatus, "claimed">;
  retryReason?: string;
  /** Current time for lease-expiry fencing. Defaults to new Date().toISOString(). */
  now?: string;
}

export interface ClaimLeaseOptions {
  workerId: string;
  leaseDurationMs: number;
  now: string;
  /**
   * Optional deterministic shadow run id generator. If omitted the
   * repository implementation mints one.
   */
  nextShadowRunId?(): string;
  /**
   * Maximum number of attempts before the scan is exhausted.
   * Defaults to 5 when omitted.
   */
  maxAttempts?: number;
}

export interface PmxtShadowLeaseRepository {
  /**
   * Atomically claim the oldest eligible unclaimed authoritative scan run.
   * Eligible scans are those the caller enumerates as completed/succeeded
   * authoritative runs that do not already have an active or completed
   * shadow lease. The repository records attempt history and returns the
   * claim details, or undefined when nothing is eligible.
   *
   * Implementations must be safe under concurrent callers: the same
   * authoritative scan must never be claimed by two workers.
   */
  claimOldestEligibleScan(options: ClaimLeaseOptions): Promise<ShadowLeaseClaim | undefined>;

  /** Finalize only an attempt still claimed by the supplied worker. */
  finalizeAttempt(options: FinalizeShadowAttemptOptions): Promise<void>;

  listAttempts(authoritativeScanRunId: string): Promise<readonly ShadowAttempt[]>;
}
