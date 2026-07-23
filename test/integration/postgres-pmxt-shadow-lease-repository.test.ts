import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresPmxtShadowLeaseRepository } from "../../src/contexts/scanner/pmxt/postgres-pmxt-shadow-lease-repository";
import { DisposablePostgresDatabase, createDisposablePostgresDatabase } from "./postgres-test-database";

let db: DisposablePostgresDatabase;
let pool: Pool;
let repository: PostgresPmxtShadowLeaseRepository;

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();
  pool = new Pool({ connectionString: db.databaseUrl });
  repository = new PostgresPmxtShadowLeaseRepository(pool);
});

afterEach(async () => {
  await pool?.end();
  await db?.close();
});

async function seedCompletedScan(id: string, completedAt: string): Promise<void> {
  await db.query(
    `insert into scan_runs (id, status, started_at, completed_at, metrics) values ($1, 'succeeded', $2::timestamptz, $2::timestamptz, '{}'::jsonb)`,
    [id, completedAt]
  );
}

async function seedRunningScan(id: string, startedAt: string): Promise<void> {
  await db.query(
    `insert into scan_runs (id, status, started_at, metrics) values ($1, 'running', $2::timestamptz, '{}'::jsonb)`,
    [id, startedAt]
  );
}

describe("PostgresPmxtShadowLeaseRepository integration", () => {
  it("claims the oldest succeeded scan and records attempt history", async () => {
    await seedCompletedScan("00000000-0000-4000-8000-000000000010", "2026-07-15T10:00:00Z");
    await seedCompletedScan("00000000-0000-4000-8000-000000000020", "2026-07-15T10:01:00Z");

    const claim = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      nextShadowRunId: () => "00000000-0000-4000-8000-00000000dead"
    });

    expect(claim?.shadowRunAttemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(claim?.authoritativeScanRunId).toBe("00000000-0000-4000-8000-000000000010");
    expect(claim?.attemptNumber).toBe(1);
    expect(claim?.leasedUntil).toBe("2026-07-15T11:01:00.000Z");

    const attempts = await repository.listAttempts(claim!.authoritativeScanRunId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].shadowRunId).toBe("00000000-0000-4000-8000-00000000dead");
  });

  it("returns undefined when no succeeded scan exists", async () => {
    const claim = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    expect(claim).toBeUndefined();
  });

  it("does not claim running scans", async () => {
    await seedRunningScan("00000000-0000-4000-8000-000000000030", "2026-07-15T10:00:00Z");

    const claim = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    expect(claim).toBeUndefined();
  });

  it("does not claim a scan with an active lease", async () => {
    const scanId = "00000000-0000-4000-8000-000000000040";
    await seedCompletedScan(scanId, "2026-07-15T10:00:00Z");

    await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z",
      nextShadowRunId: () => "00000000-0000-4000-8000-00000000aaaa"
    });

    const second = await repository.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:30.000Z"
    });

    expect(second).toBeUndefined();
  });

  it("claims a new attempt after the previous lease expires", async () => {
    const scanId = "00000000-0000-4000-8000-000000000050";
    await seedCompletedScan(scanId, "2026-07-15T10:00:00Z");

    await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    const retry = await repository.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:01:00.001Z"
    });

    expect(retry?.authoritativeScanRunId).toBe(scanId);
    expect(retry?.attemptNumber).toBe(2);
  });

  it("does not reclaim completed or sample-excluded attempts", async () => {
    const completedScanId = "00000000-0000-4000-8000-000000000060";
    const excludedScanId = "00000000-0000-4000-8000-000000000061";
    await seedCompletedScan(completedScanId, "2026-07-15T10:00:00Z");
    await seedCompletedScan(excludedScanId, "2026-07-15T10:01:00Z");

    const completed = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });
    await repository.finalizeAttempt({
      shadowRunAttemptId: completed!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "completed",
      now: "2026-07-15T11:00:30.000Z"
    });
    const excluded = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.001Z"
    });
    await repository.finalizeAttempt({
      shadowRunAttemptId: excluded!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "sample_excluded",
      retryReason: "sample_rate_excluded",
      now: "2026-07-15T11:00:30.001Z"
    });

    const retry = await repository.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:01:00.001Z"
    });

    expect(retry).toBeUndefined();
  });

  it("allows retries for failed and partial attempts and enforces worker ownership", async () => {
    const scanId = "00000000-0000-4000-8000-000000000070";
    await seedCompletedScan(scanId, "2026-07-15T10:00:00Z");
    const first = await repository.claimOldestEligibleScan({
      workerId: "worker-1",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:00:00.000Z"
    });

    await expect(
      repository.finalizeAttempt({
        shadowRunAttemptId: first!.shadowRunAttemptId,
        workerId: "worker-2",
        status: "failed",
        now: "2026-07-15T11:00:30.000Z"
      })
    ).rejects.toThrow("does not own");
    await repository.finalizeAttempt({
      shadowRunAttemptId: first!.shadowRunAttemptId,
      workerId: "worker-1",
      status: "failed",
      retryReason: "boom",
      now: "2026-07-15T11:00:30.000Z"
    });
    const second = await repository.claimOldestEligibleScan({
      workerId: "worker-2",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:02:01.000Z"
    });
    await repository.finalizeAttempt({
      shadowRunAttemptId: second!.shadowRunAttemptId,
      workerId: "worker-2",
      status: "partial",
      retryReason: "retries_exhausted",
      now: "2026-07-15T11:02:30.000Z"
    });
    const third = await repository.claimOldestEligibleScan({
      workerId: "worker-3",
      leaseDurationMs: 60_000,
      now: "2026-07-15T11:07:00.000Z"
    });

    expect(second?.attemptNumber).toBe(2);
    expect(third?.attemptNumber).toBe(3);
  });
});
