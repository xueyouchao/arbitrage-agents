import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerAppModule } from "../../src/worker-app.module";
import { WorkerScanRunner } from "../../src/contexts/scanner/worker-scan-runner";
import { ResumableScanner } from "../../src/contexts/scanner/resumable-scanner";
import { ReadOnlyScanner } from "../../src/contexts/scanner/read-only-scanner";
import { PostgresScanStepRepository } from "../../src/contexts/scanner/postgres-scan-step-repository";
import {
  KALSHI_VENUE_CLIENT,
  POLYMARKET_VENUE_CLIENT,
  SENTRY_CHECK_IN_CLIENT,
  SCAN_STEP_REPOSITORY
} from "../../src/contexts/scanner/scanner-tokens";
import { FakeSentryCheckInClient } from "../../src/contexts/observability/sentry-check-in-client";
import { kalshiPolymarketPair } from "../helpers/markets";
import { DisposablePostgresDatabase, createDisposablePostgresDatabase } from "./postgres-test-database";

const capturedAt = "2026-06-04T12:00:00.000Z";

let db: DisposablePostgresDatabase;
let app: INestApplication;
let originalDatabaseUrl: string | undefined;
let originalNodeEnv: string | undefined;

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();

  originalDatabaseUrl = process.env.DATABASE_URL;
  originalNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  await app?.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  await db?.close();
});

async function createWorkerApp(options: {
  checkInClient?: FakeSentryCheckInClient;
  innerScanner?: { runOnce: () => Promise<import("../../src/contexts/scanner/scanner-result").ScanResult> };
} = {}) {
  const fakeClients = kalshiPolymarketPair(capturedAt);
  const checkInClient = options.checkInClient ?? new FakeSentryCheckInClient();

  let builder = Test.createTestingModule({
    imports: [WorkerAppModule]
  })
    .overrideProvider(KALSHI_VENUE_CLIENT)
    .useValue(fakeClients.kalshiClient)
    .overrideProvider(POLYMARKET_VENUE_CLIENT)
    .useValue(fakeClients.polymarketClient)
    .overrideProvider(SENTRY_CHECK_IN_CLIENT)
    .useValue(checkInClient);

  if (options.innerScanner) {
    builder = builder.overrideProvider(ReadOnlyScanner).useValue(options.innerScanner);
  }

  const moduleRef = await builder.compile();
  app = moduleRef.createNestApplication();
  await app.init();

  return {
    runner: app.get(WorkerScanRunner),
    resumableScanner: app.get(ResumableScanner),
    stepRepository: app.get(SCAN_STEP_REPOSITORY) as PostgresScanStepRepository,
    checkInClient
  };
}

describe("Worker e2e smoke test against Postgres", () => {
  it("runs a fresh scan end-to-end, persists all steps, and emits ok check-ins", async () => {
    const { runner, stepRepository, checkInClient } = await createWorkerApp();

    await runner.runOnce();

    const latestRun = await db.query<{ id: string; status: string }>(
      `select id, status from scan_runs order by started_at desc limit 1`
    );
    expect(latestRun.rows).toHaveLength(1);
    expect(latestRun.rows[0].status).toBe("succeeded");

    const scanRunId = latestRun.rows[0].id;
    const steps = await stepRepository.listForRun(scanRunId);
    expect(steps.map((s) => s.stepName)).toEqual([
      "fetch_markets",
      "fetch_books",
      "normalize_markets",
      "review_pairs",
      "calculate_opportunities",
      "finalize"
    ]);
    expect(steps.every((s) => s.status === "succeeded")).toBe(true);

    expect(checkInClient.checkIns.map((c) => c.status)).toEqual(["in_progress", "ok"]);
    expect(checkInClient.checkIns[0].checkInId).toBe(checkInClient.checkIns[1].checkInId);
    expect(checkInClient.checkIns[0].slug).toBe("arbitrage-agents-scan");
  });

  it("resumes a fully-succeeded run without re-invoking the inner scanner", async () => {
    const checkInClient = new FakeSentryCheckInClient();
    const runId = "00000000-0000-4000-8000-000000000101";

    // First create a normal fresh run so the repository has baseline artifacts.
    const { runner: firstRunner } = await createWorkerApp({ checkInClient });
    await firstRunner.runOnce();
    const baselineOpportunities = await db.query<{ count: number }>(`select count(*) as count from opportunities`);
    const baselineSnapshots = await db.query<{ count: number }>(`select count(*) as count from venue_market_snapshots`);

    // Seed a second run with all steps already succeeded.
    await db.query(
      `insert into scan_runs (id, status, started_at, metrics) values ($1, 'running', '2026-06-04T11:00:00Z', '{}'::jsonb)`,
      [runId]
    );
    const seedPool = new Pool({ connectionString: db.databaseUrl });
    const seededRepository = new PostgresScanStepRepository(seedPool);
    for (const stepName of [
      "fetch_markets",
      "fetch_books",
      "normalize_markets",
      "review_pairs",
      "calculate_opportunities",
      "finalize"
    ] as const) {
      await seededRepository.saveStep({
        scanRunId: runId,
        stepName,
        status: "succeeded",
        startedAt: capturedAt,
        completedAt: capturedAt
      });
    }
    await seededRepository.markRunHeartbeat(runId, capturedAt);
    await seedPool.end();

    const innerSpy = vi.fn(async () => {
      throw new Error("inner scanner must not be invoked for a fully-succeeded resume");
    });

    await app.close();
    app = undefined as unknown as INestApplication;

    const { resumableScanner } = await createWorkerApp({
      checkInClient,
      innerScanner: { runOnce: innerSpy }
    });
    (resumableScanner as any).deps.nextScanRunId = () => runId;

    const result = await resumableScanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.id).toBe(runId);
    expect(innerSpy).not.toHaveBeenCalled();

    const resumedRepository = app.get(PostgresScanStepRepository);
    const resumedSteps = await resumedRepository.listForRun(runId);
    expect(resumedSteps.map((s) => s.stepName)).toEqual([
      "fetch_markets",
      "fetch_books",
      "normalize_markets",
      "review_pairs",
      "calculate_opportunities",
      "finalize"
    ]);

    const afterOpportunities = await db.query<{ count: number }>(`select count(*) as count from opportunities`);
    const afterSnapshots = await db.query<{ count: number }>(`select count(*) as count from venue_market_snapshots`);
    expect(Number(afterOpportunities.rows[0].count)).toBe(Number(baselineOpportunities.rows[0].count));
    expect(Number(afterSnapshots.rows[0].count)).toBe(Number(baselineSnapshots.rows[0].count));

    expect(checkInClient.checkIns.slice(-2).map((c) => c.status)).toEqual(["in_progress", "ok"]);
  });

  it("recovers a previously failed step and preserves the history", async () => {
    const checkInClient = new FakeSentryCheckInClient();
    const runId = "00000000-0000-4000-8000-000000000201";

    await db.query(
      `insert into scan_runs (id, status, started_at, metrics) values ($1, 'running', '2026-06-04T11:00:00Z', '{}'::jsonb)`,
      [runId]
    );
    const seedPool = new Pool({ connectionString: db.databaseUrl });
    const seededRepository = new PostgresScanStepRepository(seedPool);
    await seededRepository.saveStep({
      scanRunId: runId,
      stepName: "fetch_markets",
      status: "succeeded",
      startedAt: "2026-06-04T12:00:00.000Z",
      completedAt: "2026-06-04T12:00:01.000Z"
    });
    await seededRepository.saveStep({
      scanRunId: runId,
      stepName: "fetch_books",
      status: "failed",
      startedAt: "2026-06-04T12:00:02.000Z",
      completedAt: "2026-06-04T12:00:03.000Z",
      failureReason: "previous outage"
    });
    await seededRepository.markRunHeartbeat(runId, "2026-06-04T12:00:03.000Z");
    await seedPool.end();

    const { resumableScanner } = await createWorkerApp({ checkInClient });
    (resumableScanner as any).deps.nextScanRunId = () => runId;

    const result = await resumableScanner.runOnce();

    expect(result.status).toBe("succeeded");

    const finalRepository = app.get(PostgresScanStepRepository);
    const fetchBooks = (await finalRepository.listForRun(runId)).filter((s) => s.stepName === "fetch_books");
    expect(fetchBooks.map((s) => s.status)).toEqual(["failed", "succeeded"]);
    expect(fetchBooks[0].failureReason).toBe("previous outage");

    expect(checkInClient.checkIns.map((c) => c.status)).toEqual(["in_progress", "ok"]);
  });

  it("survives a Sentry check-in start failure and still completes the scan", async () => {
    const checkInClient = new FakeSentryCheckInClient();
    checkInClient.failNext();

    const { runner } = await createWorkerApp({ checkInClient });

    const result = await runner.runOnce();
    expect(result).toBeUndefined();

    // The fake still records the failed start call.
    expect(checkInClient.checkIns.length).toBeGreaterThan(0);

    const latestRun = await db.query<{ status: string }>(
      `select status from scan_runs order by started_at desc limit 1`
    );
    expect(latestRun.rows[0].status).toBe("succeeded");
  });
});
