import { describe, expect, it } from "vitest";
import { InMemoryPmxtShadowLeaseRepository } from "../../src/contexts/scanner/pmxt/in-memory-pmxt-shadow-lease-repository";

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
});
