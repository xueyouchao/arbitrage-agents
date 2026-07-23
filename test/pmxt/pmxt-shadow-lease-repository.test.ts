import { describe, expect, it } from "vitest";
import { InMemoryPmxtShadowLeaseRepository, computeNextRetryAt } from "../../src/contexts/scanner/pmxt/in-memory-pmxt-shadow-lease-repository";

describe("InMemoryPmxtShadowLeaseRepository", () => {
  it("claims the oldest unclaimed completed scan and records attempt history", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" },
      { scanRunId: "scan-b", completedAt: "2026-07-15T10:01:00.000Z" },
      { scanRunId: "scan-c", completedAt: "2026-07-15T10:02:00.000Z" }
    ]);

    const first = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      nextShadowRunId: () => "shadow-a"
    });

    expect(first).toEqual({
      shadowRunAttemptId: expect.any(String),
      authoritativeScanRunId: "scan-a",
      shadowRunId: "shadow-a",
      attemptNumber: 1,
      claimedAt: "2026-07-15T11:00:00.000Z",
      leasedUntil: "2026-07-15T11:01:00.000Z"
    });

    const second = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:01.000Z",
      nextShadowRunId: () => "shadow-b"
    });

    expect(second?.authoritativeScanRunId).toBe("scan-b");
  });

  it("returns undefined when all scans are already claimed", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);

    await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      nextShadowRunId: () => "shadow-a"
    });

    const again = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:01.000Z",
      nextShadowRunId: () => "shadow-b"
    });

    expect(again).toBeUndefined();
  });

  it("permits a new claim when the prior lease has expired", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);

    await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      nextShadowRunId: () => "shadow-a"
    });

    const retry = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:01:00.001Z",
      nextShadowRunId: () => "shadow-b"
    });

    expect(retry?.authoritativeScanRunId).toBe("scan-a");
    expect(retry?.attemptNumber).toBe(2);
  });

  it.each(["completed", "sample_excluded"] as const)(
    "does not reclaim a scan after a terminal %s attempt",
    async (status) => {
      const repo = new InMemoryPmxtShadowLeaseRepository([
        { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
      ]);
      const claim = await repo.claimOldestEligibleScan({
        workerId: "worker-1",
        leaseDurationMs: 60_000,
        now: "2026-07-15T11:00:00.000Z",
        nextShadowRunId: () => "shadow-a"
      });

      await repo.finalizeAttempt({
        shadowRunAttemptId: claim!.shadowRunAttemptId,
        workerId: "worker-1",
        status,
        retryReason: status === "sample_excluded" ? "sample_rate_excluded" : undefined,
        now: "2026-07-15T11:00:30.000Z"
      });

      const retry = await repo.claimOldestEligibleScan({
        workerId: "worker-2",
        leaseDurationMs: 60_000,
        now: "2026-07-15T11:01:00.001Z"
      });

      expect(retry).toBeUndefined();
    }
  );

  it.each(["partial", "failed"] as const)(
    "allows attempt_number + 1 after a retryable %s attempt (after backoff)",
    async (status) => {
      const repo = new InMemoryPmxtShadowLeaseRepository([
        { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
      ]);
      const claim = await repo.claimOldestEligibleScan({
        workerId: "worker-1",
        leaseDurationMs: 60_000,
        now: "2026-07-15T11:00:00.000Z"
      });

      await repo.finalizeAttempt({
        shadowRunAttemptId: claim!.shadowRunAttemptId,
        workerId: "worker-1",
        status,
        retryReason: "retryable",
        now: "2026-07-15T11:00:30.000Z"
      });

      // Wait past the backoff (2^1 * 60s = 120s)
      const retry = await repo.claimOldestEligibleScan({
        workerId: "worker-2",
        leaseDurationMs: 60_000,
        now: "2026-07-15T11:02:01.000Z"
      });

      expect(retry?.attemptNumber).toBe(2);
    }
  );

  it("rejects finalization by a worker that does not own the attempt", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    await expect(
      repo.finalizeAttempt({
        shadowRunAttemptId: claim!.shadowRunAttemptId,
        workerId: "worker-2",
        status: "completed",
        now: "2026-07-15T11:00:30.000Z"
      })
    ).rejects.toThrow("does not own");
  });

  // --- Lease fairness / retry policy ---

  it("sets next_retry_at with deterministic backoff on retryable finalization", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    await repo.finalizeAttempt({
      shadowRunAttemptId: claim!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      retryReason: "boom",
      now: "2026-07-15T11:00:30.000Z"
    });

    const attempts = await repo.listAttempts("scan-a");
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].nextRetryAt).toBeDefined();
    // 2^1 * 60s = 120s backoff from claimedAt
    expect(attempts[0].nextRetryAt).toBe("2026-07-15T11:02:00.000Z");
  });

  it("does not claim a scan whose next_retry_at has not elapsed", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });
    await repo.finalizeAttempt({
      shadowRunAttemptId: claim!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      now: "2026-07-15T11:00:30.000Z"
    });

    // next_retry_at = 11:02:00, try at 11:01:00 — should be blocked
    const retry = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:01:00.000Z"
    });
    expect(retry).toBeUndefined();
  });

  it("claims a scan after next_retry_at has elapsed", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });
    await repo.finalizeAttempt({
      shadowRunAttemptId: claim!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      now: "2026-07-15T11:00:30.000Z"
    });

    // next_retry_at = 11:02:00, try at 11:02:01 — should succeed
    const retry = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:02:01.000Z"
    });
    expect(retry?.attemptNumber).toBe(2);
  });

  it("exhausts a scan after max_attempts retryable failures", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);

    // Claim and fail 5 times (max_attempts=5 default)
    for (let i = 0; i < 5; i++) {
      const claim = await repo.claimOldestEligibleScan({
        workerId: `worker-${i}`,
        leaseDurationMs: 60_000,
        now: `2026-07-15T1${i}:00:00.000Z`
      });
      expect(claim).toBeDefined();
      await repo.finalizeAttempt({
        shadowRunAttemptId: claim!.shadowRunAttemptId,
        workerId: `worker-${i}`,
        status: "failed",
        now: `2026-07-15T1${i}:00:30.000Z`
      });
    }

    // 6th attempt should be blocked — exhausted
    const exhausted = await repo.claimOldestEligibleScan({
      workerId: "worker-final",
      leaseDurationMs: 60_000,
      now: "2026-07-15T20:00:00.000Z"
    });
    expect(exhausted).toBeUndefined();

    const attempts = await repo.listAttempts("scan-a");
    expect(attempts[4].status).toBe("exhausted");
  });

  it("allows subsequent scans to be claimed while a prior scan is in backoff", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" },
      { scanRunId: "scan-b", completedAt: "2026-07-15T10:01:00.000Z" }
    ]);

    // Claim and fail scan-a
    const claimA = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });
    await repo.finalizeAttempt({
      shadowRunAttemptId: claimA!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      now: "2026-07-15T11:00:30.000Z"
    });

    // scan-a is in backoff, scan-b should be claimable
    const claimB = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:01.000Z"
    });
    expect(claimB?.authoritativeScanRunId).toBe("scan-b");
  });

  it("respects custom max_attempts", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);

    // Claim with maxAttempts=2
    const claim1 = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      maxAttempts: 2
    });
    await repo.finalizeAttempt({
      shadowRunAttemptId: claim1!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      now: "2026-07-15T11:00:30.000Z"
    });

    const claim2 = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T12:00:00.000Z",
      maxAttempts: 2
    });
    await repo.finalizeAttempt({
      shadowRunAttemptId: claim2!.shadowRunAttemptId,
      workerId: "worker-2",
      status: "failed",
      now: "2026-07-15T12:00:30.000Z"
    });

    // 3rd attempt should be blocked — exhausted at maxAttempts=2
    const claim3 = await repo.claimOldestEligibleScan({
      workerId: "worker-3",
      leaseDurationMs: 60_000,
      now: "2026-07-15T13:00:00.000Z",
      maxAttempts: 2
    });
    expect(claim3).toBeUndefined();
  });
});

describe("computeNextRetryAt", () => {
  it("computes 2^attempt * 60s backoff", () => {
    expect(computeNextRetryAt(1, "2026-07-15T11:00:00.000Z")).toBe("2026-07-15T11:02:00.000Z");
    expect(computeNextRetryAt(2, "2026-07-15T11:00:00.000Z")).toBe("2026-07-15T11:04:00.000Z");
    expect(computeNextRetryAt(3, "2026-07-15T11:00:00.000Z")).toBe("2026-07-15T11:08:00.000Z");
  });

  it("caps backoff at 1 hour", () => {
    // 2^10 * 60s = 1024 minutes > 1 hour, should cap
    const result = computeNextRetryAt(10, "2026-07-15T11:00:00.000Z");
    expect(result).toBe("2026-07-15T12:00:00.000Z");
  });
});

describe("Fencing", () => {
  it("rejects finalizeAttempt when the lease has expired", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    // Attempt to finalize after lease expiry (leased_until = 11:01:00)
    await expect(
      repo.finalizeAttempt({
        shadowRunAttemptId: claim!.shadowRunAttemptId,
        workerId: "worker-1",
        status: "completed",
        now: "2026-07-15T11:01:00.001Z"
      })
    ).rejects.toThrow("lease has expired");
  });

  it("allows finalizeAttempt while the lease is still active", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);
    const claim = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    // Finalize within lease window
    await repo.finalizeAttempt({
      shadowRunAttemptId: claim!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "completed",
      now: "2026-07-15T11:00:30.000Z"
    });

    const attempts = await repo.listAttempts("scan-a");
    expect(attempts[0].status).toBe("completed");
  });

  it("prevents stale worker from writing track data after another worker has claimed", async () => {
    const repo = new InMemoryPmxtShadowLeaseRepository([
      { scanRunId: "scan-a", completedAt: "2026-07-15T10:00:00.000Z" }
    ]);

    // Worker 1 claims
    const claim1 = await repo.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    // Worker 1's lease expires, worker 2 claims
    const claim2 = await repo.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:01:00.001Z"
    });
    expect(claim2?.attemptNumber).toBe(2);

    // Worker 1 tries to finalize its stale claim — must be rejected
    await expect(
      repo.finalizeAttempt({
        shadowRunAttemptId: claim1!.shadowRunAttemptId,
        workerId: "worker-1",
        status: "completed",
        now: "2026-07-15T11:01:00.001Z"
      })
    ).rejects.toThrow("lease has expired");
  });
});
