import { describe, expect, it, vi } from "vitest";
import { RESUMABLE_SCAN_STEP_NAMES, ResumableScanner, ScanStepName } from "../src/contexts/scanner/resumable-scanner";
import { InMemoryScannerRepository, InMemoryScanStepRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { ScanResult } from "../src/contexts/scanner/scanner-result";
import { ScanStepArtifact, ScanStepRepository, ScanStepRow } from "../src/contexts/scanner/scan-step";
import { VenueClient } from "../src/contexts/venues/domain/venue-market";
import { CapturedCheckIn, FakeSentryCheckInClient, SentryCheckInHandle } from "../src/contexts/observability/sentry-check-in-client";
import { kalshiPolymarketPair as buildKalshiPolymarketPair } from "./helpers/markets";

const capturedAt = "2026-06-04T12:00:00.000Z";

function kalshiPolymarketPair(): { kalshiClient: VenueClient; polymarketClient: VenueClient } {
  return buildKalshiPolymarketPair(capturedAt);
}

function buildResumableScanner(
  repository: InMemoryScannerRepository,
  stepRepository: InMemoryScanStepRepository,
  options: {
    kalshiClient?: VenueClient;
    polymarketClient?: VenueClient;
    checkInClient?: FakeSentryCheckInClient;
    clock?: () => string;
    nextScanRunId?: () => string;
    workerId?: string;
  } = {}
) {
  const clients = kalshiPolymarketPair();
  const checkInClient = options.checkInClient ?? new FakeSentryCheckInClient();
  const clock = options.clock ?? (() => "2026-06-04T11:59:59.000Z");
  const innerScanner = new ReadOnlyScanner({
    kalshiClient: options.kalshiClient ?? clients.kalshiClient,
    polymarketClient: options.polymarketClient ?? clients.polymarketClient,
    repository,
    clock
  });
  return {
    scanner: new ResumableScanner({
      innerScanner,
      stepRepository,
      checkInClient,
      monitorSlug: "arbitrage-agents-scan",
      clock,
      nextScanRunId: options.nextScanRunId,
      workerId: options.workerId
    }),
    checkInClient,
    stepRepository
  };
}

describe("ResumableScanner", () => {
  it("runs a full scan, records every step, and emits ok+close Sentry check-ins", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { scanner, checkInClient, stepRepository: steps } = buildResumableScanner(repository, stepRepository);

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    const allSteps = await steps.listForRun(result.id);
    const stepNames = allSteps.map((s) => s.stepName);
    expect(stepNames).toEqual([
      "fetch_markets",
      "fetch_books",
      "normalize_markets",
      "review_pairs",
      "calculate_opportunities",
      "finalize"
    ]);
    expect(allSteps.every((s) => s.status === "succeeded")).toBe(true);
    expect(checkInClient.checkIns.map((c) => ({ slug: c.slug, status: c.status }))).toEqual([
      { slug: "arbitrage-agents-scan", status: "in_progress" },
      { slug: "arbitrage-agents-scan", status: "ok" }
    ]);
    expect(checkInClient.checkIns[0].checkInId).toBeDefined();
    expect(checkInClient.checkIns[1].checkInId).toBe(checkInClient.checkIns[0].checkInId);
  });

  it("emits error check-in and marks the failed step when the inner scanner throws", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const innerScanner = {
      runOnce: vi.fn(async () => {
        throw new Error("fetch_markets blew up: https://x.test/?api_key=secret");
      })
    } as unknown as ReadOnlyScanner;

    const checkInClient = new FakeSentryCheckInClient();
    const scanner = new ResumableScanner({
      innerScanner,
      stepRepository,
      checkInClient,
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z"
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("failed");
    expect(result.failureReason).not.toContain("secret");
    expect(checkInClient.checkIns.map((c) => c.status)).toEqual(["in_progress", "error"]);
    const failedSteps = await stepRepository.listForRun(result.id);
    expect(failedSteps.find((s) => s.stepName === "fetch_markets")?.status).toBe("failed");
    const failedStepNames = failedSteps.map((s) => s.stepName);
    expect(failedStepNames).toEqual(["fetch_markets"]);
    expect(failedSteps.find((s) => s.stepName === "fetch_books")).toBeUndefined();
    expect(failedSteps.find((s) => s.stepName === "normalize_markets")).toBeUndefined();
    expect(failedSteps.find((s) => s.stepName === "review_pairs")).toBeUndefined();
    expect(failedSteps.find((s) => s.stepName === "calculate_opportunities")).toBeUndefined();
    expect(failedSteps.find((s) => s.stepName === "finalize")).toBeUndefined();
  });

  it("records remaining steps as succeeded after a successful inner scanner resume", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();

    // Resume under a fresh scan id; only fetch_markets is pre-seeded as
    // succeeded, simulating a run that completed fetch_markets before the
    // worker crashed. The orchestrator should skip fetch_markets, invoke
    // the inner scanner once, and mark the remaining five steps succeeded.
    const resumeScanId = "scan-resume-partial";
    await stepRepository.saveStep({
      scanRunId: resumeScanId,
      stepName: "fetch_markets",
      status: "succeeded",
      startedAt: capturedAt,
      completedAt: capturedAt,
      attempt: 1
    });

    const innerSpy = vi.fn(async (_scanRunId?: string) => {
      const innerResult: ScanResult = {
        id: _scanRunId ?? "unexpected",
        status: "succeeded",
        startedAt: "2026-06-04T12:00:00.000Z",
        completedAt: "2026-06-04T12:00:01.000Z",
        metrics: { marketsScanned: 2, normalizedMarkets: 2, candidatePairs: 1, opportunitiesFound: 1, llmEvaluations: 0 }
      };
      return innerResult;
    });
    const innerScanner = { runOnce: innerSpy } as unknown as ReadOnlyScanner;

    const resumeScanner = new ResumableScanner({
      innerScanner,
      stepRepository,
      checkInClient: new FakeSentryCheckInClient(),
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z",
      nextScanRunId: () => resumeScanId
    });

    const resumed = await resumeScanner.runOnce();

    expect(resumed.id).toBe(resumeScanId);
    expect(resumed.status).toBe("succeeded");
    expect(innerSpy).toHaveBeenCalledTimes(1);
    const resumedSteps = await stepRepository.listForRun(resumeScanId);
    expect(resumedSteps.map((s) => s.stepName)).toEqual([
      "fetch_markets",
      "fetch_books",
      "normalize_markets",
      "review_pairs",
      "calculate_opportunities",
      "finalize"
    ]);
    expect(resumedSteps.every((s) => s.status === "succeeded")).toBe(true);
    expect(resumedSteps.filter((s) => s.stepName !== "fetch_markets").every((s) => s.metadata?.executedBy === "inner_scanner")).toBe(true);
  });

  it("skips a fully-succeeded resume without invoking the inner scanner", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();

    // Resume under a fresh scan id; all six steps are pre-seeded as
    // succeeded so the orchestrator has nothing to execute.
    const resumeScanId = "scan-resume-full";
    for (const stepName of RESUMABLE_SCAN_STEP_NAMES) {
      await stepRepository.saveStep({ scanRunId: resumeScanId, stepName, status: "succeeded", startedAt: capturedAt, completedAt: capturedAt, attempt: 1 });
    }

    const innerSpy = vi.fn(async () => {
      throw new Error("inner scanner must not be invoked for a fully-succeeded run");
    });
    const innerScanner = { runOnce: innerSpy } as unknown as ReadOnlyScanner;

    const resumeScanner = new ResumableScanner({
      innerScanner,
      stepRepository,
      checkInClient: new FakeSentryCheckInClient(),
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z",
      nextScanRunId: () => resumeScanId
    });

    const resumed = await resumeScanner.runOnce();

    expect(resumed.id).toBe(resumeScanId);
    expect(resumed.status).toBe("succeeded");
    expect(innerSpy).not.toHaveBeenCalled();
    const resumedSteps = await stepRepository.listForRun(resumeScanId);
    expect(resumedSteps.map((s) => s.stepName)).toEqual(RESUMABLE_SCAN_STEP_NAMES);
    expect(resumedSteps.every((s) => s.status === "succeeded")).toBe(true);
  });

  it("reruns a previously failed step instead of leaving the run stuck", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { stepRepository: steps } = buildResumableScanner(repository, stepRepository);

    // Pre-seed two succeeded steps and one failed step to simulate a
    // crashed run that needs recovery.
    const scanRunId = "scan-recovery";
    await stepRepository.saveStep({ scanRunId, stepName: "fetch_markets", status: "succeeded", startedAt: capturedAt, completedAt: capturedAt, attempt: 1 });
    await stepRepository.saveStep({ scanRunId, stepName: "fetch_books", status: "failed", startedAt: capturedAt, completedAt: capturedAt, attempt: 1, failureReason: "previous outage" });

    const checkInClient = new FakeSentryCheckInClient();
    const resumeScanner = new ResumableScanner({
      innerScanner: new ReadOnlyScanner({
        kalshiClient: kalshiPolymarketPair().kalshiClient,
        polymarketClient: kalshiPolymarketPair().polymarketClient,
        repository
      }),
      stepRepository,
      checkInClient,
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z",
      nextScanRunId: () => scanRunId
    });

    const resumed = await resumeScanner.runOnce();

    expect(resumed.status).toBe("succeeded");
    const allSteps = await steps.listForRun(scanRunId);
    const fetchBooks = allSteps.filter((s) => s.stepName === "fetch_books");
    expect(fetchBooks.map((s) => s.status)).toEqual(["failed", "succeeded"]);
    expect(checkInClient.checkIns.map((c) => c.status)).toEqual(["in_progress", "ok"]);
  });

  it("keeps step history: re-saving a succeeded step appends a new attempt", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { scanner, stepRepository: steps } = buildResumableScanner(repository, stepRepository);

    const result = await scanner.runOnce();
    const completed = await steps.listForRun(result.id);
    const fetchMarketsRows = completed.filter((s) => s.stepName === "fetch_markets");
    expect(fetchMarketsRows).toHaveLength(1);

    // Re-saving the same succeeded step records a new attempt so the
    // operator trail shows every retry, matching the Postgres history
    // semantics. Omit the explicit attempt number so the repository auto-
    // increments it.
    await stepRepository.saveStep({ ...fetchMarketsRows[0], attempt: undefined });
    const refetched = await steps.listForRun(result.id);
    const refetchedFetchMarkets = refetched.filter((s) => s.stepName === "fetch_markets");
    expect(refetchedFetchMarkets).toHaveLength(2);
    expect(refetchedFetchMarkets[0].attempt).toBe(1);
    expect(refetchedFetchMarkets[1].attempt).toBe(2);
  });

  it("survives check-in client failures and still completes the scan", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const checkInClient = new FakeSentryCheckInClient();
    checkInClient.failNext();
    const { scanner } = buildResumableScanner(repository, stepRepository, { checkInClient });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    // The fake still records the call, even when it throws.
    expect(checkInClient.checkIns.length).toBeGreaterThan(0);
  });

  it("exposes the full list of resumable step names in declaration order", () => {
    const names: ScanStepName[] = ["fetch_markets", "fetch_books", "normalize_markets", "review_pairs", "calculate_opportunities", "finalize"];
    expect(RESUMABLE_SCAN_STEP_NAMES).toEqual(names);
  });

  it("captures a complete check-in lifecycle in the fake", async () => {
    const fake = new FakeSentryCheckInClient();
    const handle: SentryCheckInHandle = await fake.start("monitor", new Date("2026-06-04T12:00:00Z"));
    await fake.ok(handle, new Date("2026-06-04T12:00:05Z"));
    expect(fake.checkIns).toEqual<CapturedCheckIn[]>([
      { slug: "monitor", checkInId: handle.checkInId, status: "in_progress", startedAt: "2026-06-04T12:00:00.000Z" },
      { slug: "monitor", checkInId: handle.checkInId, status: "ok", startedAt: "2026-06-04T12:00:05.000Z" }
    ]);
  });

  // Finding #6: the scan result must carry the workerId so the
  // abandoned-scan detector can skip runs owned by the active worker.
  it("stamps workerId on the scan result when configured", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { scanner } = buildResumableScanner(repository, stepRepository, { workerId: "worker-42" });
    const result = await scanner.runOnce();
    expect(result.workerId).toBe("worker-42");
  });

  it("omits workerId from scan result when not configured", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { scanner } = buildResumableScanner(repository, stepRepository);
    const result = await scanner.runOnce();
    expect(result.workerId).toBeUndefined();
  });

  // Issue #24: regression guard. The Postgres `scan_steps.scan_run_id`
  // column has a foreign key onto `scan_runs.id`. Two invariants must
  // hold together:
  //   1. The `scan_runs` row must exist BEFORE any `scan_steps` row.
  //   2. The `scan_runs` row must use the SAME id the orchestrator
  //      chose for its step trail. Otherwise the FK points nowhere and
  //      the database rejects the step insert.
  // The previous bug satisfied (1) by accident — the inner scanner
  // happened to write its `scan_runs` row first — but used a DIFFERENT
  // id, so Postgres still rejected the step insert with a FK violation.
  it("persists the scan_runs row with the same id the orchestrator chose for its step trail", async () => {
    const events: string[] = [];
    const repository = new InMemoryScannerRepository();
    const stepRepository: ScanStepRepository = {
      async saveStep(step: ScanStepArtifact): Promise<ScanStepRow> {
        events.push(`saveStep:${step.stepName}:${step.status}:${step.scanRunId}`);
        return {
          id: `row-${events.length}`,
          scanRunId: step.scanRunId,
          stepName: step.stepName,
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          attempt: 1,
          failureReason: step.failureReason,
          metadata: step.metadata ?? {}
        };
      },
      async listForRun() { return []; },
      async getStep() { return undefined; },
      async markRunHeartbeat(scanRunId: string) {
        events.push(`markRunHeartbeat:${scanRunId}`);
      }
    };

    // Wrap the in-memory repository to record when the inner scanner
    // (or anyone) writes a scan_runs row.
    const originalSaveScanRun = repository.saveScanRun.bind(repository);
    repository.saveScanRun = (scanRun: ScanResult): Promise<void> => {
      events.push(`saveScanRun:${scanRun.id}:${scanRun.status}`);
      return originalSaveScanRun(scanRun);
    };

    const innerScanner = new ReadOnlyScanner({
      kalshiClient: kalshiPolymarketPair().kalshiClient,
      polymarketClient: kalshiPolymarketPair().polymarketClient,
      repository
    });

    const scanner = new ResumableScanner({
      innerScanner,
      stepRepository,
      checkInClient: new FakeSentryCheckInClient(),
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z",
      nextScanRunId: () => "scan-fk-order"
    });

    const result = await scanner.runOnce();
    expect(result.status).toBe("succeeded");
    expect(result.id).toBe("scan-fk-order");

    // (1) The first scan_runs write must precede the first scan_steps write.
    const firstSaveScanRunAt = events.findIndex((e) => e.startsWith("saveScanRun:"));
    const firstSaveStepAt = events.findIndex((e) => e.startsWith("saveStep:"));
    expect(firstSaveScanRunAt).toBeGreaterThanOrEqual(0);
    expect(firstSaveStepAt).toBeGreaterThanOrEqual(0);
    expect(firstSaveScanRunAt).toBeLessThan(firstSaveStepAt);

    // (2) The scan_runs row must use the same id the step trail uses.
    // The orchestrator chose "scan-fk-order" via `nextScanRunId`. Every
    // step row references that id; the scan_runs row must too.
    const stepIds = events
      .filter((e) => e.startsWith("saveStep:"))
      .map((e) => e.split(":")[3]);
    expect(stepIds.length).toBeGreaterThan(0);
    expect(new Set(stepIds)).toEqual(new Set(["scan-fk-order"]));
    const scanRunIds = events
      .filter((e) => e.startsWith("saveScanRun:"))
      .map((e) => e.split(":")[1]);
    expect(scanRunIds).toContain("scan-fk-order");
  });

  // Issue #24: regression guard. The `scan_runs` row inserted by the
  // inner scanner must use the SAME id the orchestrator chose for its
  // step trail. Otherwise the `scan_steps.scan_run_id` foreign key has
  // nothing to point at and the database rejects the insert.
  it("threads its scanRunId into the inner scanner so the scan_runs row matches the step trail", async () => {
    const innerCalls: Array<string | undefined> = [];
    const repository = new InMemoryScannerRepository();
    const innerScanner = {
      runOnce: vi.fn(async (scanRunId?: string) => {
        innerCalls.push(scanRunId);
        return {
          id: scanRunId ?? "unexpected",
          status: "succeeded" as const,
          startedAt: "2026-06-04T12:00:00.000Z",
          completedAt: "2026-06-04T12:00:01.000Z",
          metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 }
        };
      })
    } as unknown as ReadOnlyScanner;

    const scanner = new ResumableScanner({
      innerScanner,
      stepRepository: new InMemoryScanStepRepository(),
      checkInClient: new FakeSentryCheckInClient(),
      monitorSlug: "arbitrage-agents-scan",
      clock: () => "2026-06-04T12:00:00.000Z",
      nextScanRunId: () => "scan-passthrough"
    });

    const result = await scanner.runOnce();
    expect(result.id).toBe("scan-passthrough");
    expect(innerCalls).toEqual(["scan-passthrough"]);
  });
});
