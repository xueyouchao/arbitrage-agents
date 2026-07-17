export interface ShadowLeaseClaim {
  authoritativeScanRunId: string;
  shadowRunId: string;
  attemptNumber: number;
  claimedAt: string;
  leasedUntil: string;
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
}
