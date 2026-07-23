import { randomUUID } from "crypto";
import {
  ClaimLeaseOptions,
  FinalizeShadowAttemptOptions,
  PmxtShadowLeaseRepository,
  ShadowAttempt,
  ShadowAttemptStatus,
  ShadowLeaseClaim
} from "./pmxt-shadow-lease-repository";

export interface AuthoritativeScanSummary {
  scanRunId: string;
  completedAt: string;
}

export class InMemoryPmxtShadowLeaseRepository implements PmxtShadowLeaseRepository {
  private readonly attempts = new Map<string, ShadowAttempt[]>();

  constructor(private readonly eligibleScans: readonly AuthoritativeScanSummary[]) {}

  async claimOldestEligibleScan(options: ClaimLeaseOptions): Promise<ShadowLeaseClaim | undefined> {
    const maxAttempts = options.maxAttempts ?? 5;
    const sorted = [...this.eligibleScans].sort(
      (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
    );

    for (const scan of sorted) {
      const history = this.attempts.get(scan.scanRunId) ?? [];
      if (history.some((attempt) => isTerminal(attempt.status))) continue;
      if (history.some((attempt) => attempt.status === "claimed" && attempt.leasedUntil > options.now)) {
        continue;
      }
      // Exclude attempts whose deterministic backoff has not yet elapsed.
      if (history.some((attempt) => {
        if (!isRetryable(attempt.status)) return false;
        if (!attempt.nextRetryAt) return false;
        return attempt.nextRetryAt > options.now;
      })) {
        continue;
      }

      const attemptNumber = history.length + 1;
      const attempt: ShadowAttempt = {
        shadowRunAttemptId: randomUUID(),
        authoritativeScanRunId: scan.scanRunId,
        shadowRunId: options.nextShadowRunId ? options.nextShadowRunId() : randomUUID(),
        attemptNumber,
        claimedAt: options.now,
        leasedUntil: new Date(
          new Date(options.now).getTime() + options.leaseDurationMs
        ).toISOString(),
        workerId: options.workerId,
        status: "claimed",
        maxAttempts
      };

      this.attempts.set(scan.scanRunId, [...history, attempt]);
      return toClaim(attempt);
    }

    return undefined;
  }

  async finalizeAttempt(options: FinalizeShadowAttemptOptions): Promise<void> {
    for (const history of this.attempts.values()) {
      const attempt = history.find(
        (candidate) => candidate.shadowRunAttemptId === options.shadowRunAttemptId
      );
      if (!attempt) continue;
      if (attempt.workerId !== options.workerId) {
        throw new Error(`worker ${options.workerId} does not own shadow attempt`);
      }
      if (attempt.status !== "claimed") {
        throw new Error("shadow attempt is not claimed");
      }
      // Fencing: reject finalization if the lease has expired.
      const now = options.now ?? new Date().toISOString();
      if (attempt.leasedUntil <= now) {
        throw new Error("shadow attempt lease has expired");
      }
      attempt.status = options.status;
      attempt.retryReason = options.retryReason;

      // Compute deterministic backoff for retryable statuses.
      if (isRetryable(options.status)) {
        if (attempt.attemptNumber >= attempt.maxAttempts) {
          attempt.status = "exhausted";
        } else {
          attempt.nextRetryAt = computeNextRetryAt(attempt.attemptNumber, now);
        }
      }
      return;
    }
    throw new Error("shadow attempt not found");
  }

  async listAttempts(authoritativeScanRunId: string): Promise<readonly ShadowAttempt[]> {
    return (this.attempts.get(authoritativeScanRunId) ?? []).map((attempt) => ({ ...attempt }));
  }
}

function isTerminal(status: ShadowAttemptStatus): boolean {
  return status === "completed" || status === "sample_excluded" || status === "exhausted";
}

function isRetryable(status: ShadowAttemptStatus): boolean {
  return status === "partial" || status === "failed";
}

/**
 * Deterministic exponential backoff: 2^attempt * 60s, capped at 1 hour.
 * Anchored to `now` (finalize time) so long-running attempts still get
 * the full backoff window after completion.
 */
export function computeNextRetryAt(attemptNumber: number, now: string): string {
  const backoffMs = Math.min(Math.pow(2, attemptNumber) * 60_000, 3_600_000);
  return new Date(new Date(now).getTime() + backoffMs).toISOString();
}

function toClaim(attempt: ShadowAttempt): ShadowLeaseClaim {
  const {
    shadowRunAttemptId,
    authoritativeScanRunId,
    shadowRunId,
    attemptNumber,
    claimedAt,
    leasedUntil
  } = attempt;
  return {
    shadowRunAttemptId,
    authoritativeScanRunId,
    shadowRunId,
    attemptNumber,
    claimedAt,
    leasedUntil
  };
}
