import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresScanStepRepository } from "../../src/contexts/scanner/postgres-scan-step-repository";
import { DisposablePostgresDatabase, createDisposablePostgresDatabase } from "./postgres-test-database";

let db: DisposablePostgresDatabase;
let pool: Pool;
let repository: PostgresScanStepRepository;

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();
  pool = new Pool({ connectionString: db.databaseUrl });
  repository = new PostgresScanStepRepository(pool);
});

afterEach(async () => {
  await pool.end();
  await db.close();
});

describe("PostgresScanStepRepository integration", () => {
  it("round-trips step history through listForRun and getStep", async () => {
    const scanRunId = "00000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into scan_runs (id, status, started_at, metrics) values ($1, 'running', '2026-06-04T12:00:00Z', '{}'::jsonb)`,
      [scanRunId]
    );

    await repository.saveStep({
      scanRunId,
      stepName: "fetch_markets",
      status: "failed",
      startedAt: "2026-06-04T12:00:01.000Z",
      completedAt: "2026-06-04T12:00:02.000Z",
      failureReason: "venue timeout",
      metadata: { attemptKind: "initial" }
    });
    await repository.saveStep({
      scanRunId,
      stepName: "fetch_markets",
      status: "succeeded",
      startedAt: "2026-06-04T12:00:03.000Z",
      completedAt: "2026-06-04T12:00:04.000Z",
      attempt: 2,
      metadata: { attemptKind: "retry" }
    });
    await repository.saveStep({
      scanRunId,
      stepName: "fetch_books",
      status: "succeeded",
      startedAt: "2026-06-04T12:00:05.000Z",
      completedAt: "2026-06-04T12:00:06.000Z"
    });

    const steps = await repository.listForRun(scanRunId);
    expect(steps.map((step) => [step.stepName, step.status, step.attempt])).toEqual([
      ["fetch_markets", "failed", 1],
      ["fetch_markets", "succeeded", 2],
      ["fetch_books", "succeeded", 1]
    ]);
    expect(steps[0].failureReason).toBe("venue timeout");
    expect(steps[1].metadata).toEqual({ attemptKind: "retry" });

    const latestFetchMarkets = await repository.getStep(scanRunId, "fetch_markets");
    expect(latestFetchMarkets?.status).toBe("succeeded");
    expect(latestFetchMarkets?.attempt).toBe(2);
  });

  it("isolates runs and returns undefined for missing steps", async () => {
    const runA = "00000000-0000-4000-8000-000000000011";
    const runB = "00000000-0000-4000-8000-000000000012";
    await db.query(
      `insert into scan_runs (id, status, started_at, metrics) values
       ($1, 'running', '2026-06-04T12:00:00Z', '{}'::jsonb),
       ($2, 'running', '2026-06-04T12:01:00Z', '{}'::jsonb)`,
      [runA, runB]
    );

    await repository.saveStep({ scanRunId: runA, stepName: "fetch_markets", status: "succeeded", startedAt: "2026-06-04T12:00:01Z" });
    await repository.saveStep({ scanRunId: runB, stepName: "fetch_books", status: "succeeded", startedAt: "2026-06-04T12:01:01Z" });

    expect((await repository.listForRun(runA)).map((step) => step.stepName)).toEqual(["fetch_markets"]);
    expect(await repository.getStep(runA, "fetch_books")).toBeUndefined();
    expect(await repository.listForRun("00000000-0000-4000-8000-000000009999")).toEqual([]);
  });

  it("persists scan_run heartbeats", async () => {
    const scanRunId = "00000000-0000-4000-8000-000000000021";
    await db.query(
      `insert into scan_runs (id, status, started_at, metrics) values ($1, 'running', '2026-06-04T12:00:00Z', '{}'::jsonb)`,
      [scanRunId]
    );

    await repository.markRunHeartbeat(scanRunId, "2026-06-04T12:03:00.000Z");

    const result = await db.query<{ heartbeat_at: Date }>(`select heartbeat_at from scan_runs where id = $1`, [scanRunId]);
    expect(result.rows[0].heartbeat_at.toISOString()).toBe("2026-06-04T12:03:00.000Z");
  });
});
