import { describe, expect, it, vi } from "vitest";
import { RESUMABLE_SCAN_STEP_NAMES, ResumableScanner, ScanStepName } from "../src/contexts/scanner/resumable-scanner";
import { InMemoryScannerRepository, InMemoryScanStepRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
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
      nextScanRunId: options.nextScanRunId
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
    expect(steps.byRunId.get(result.id)).toBeDefined();
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
  });

  it("skips already-succeeded steps on resume and does not duplicate persisted rows", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();

    // First run produces real persisted artifacts (snapshots, opportunities).
    const { scanner: firstScanner } = buildResumableScanner(repository, stepRepository);
    const first = await firstScanner.runOnce();
    expect(first.status).toBe("succeeded");
    const opportunitiesAfterFirst = repository.opportunities.length;
    const snapshotsAfterFirst = repository.orderbookSnapshots.length;

    // Resume under a fresh scan id; the first three steps are pre-seeded
    // as succeeded for that id so the orchestrator must skip them.
    const resumeScanId = "scan-resume-1";
    for (const stepName of ["fetch_markets", "fetch_books", "normalize_markets"] as const) {
      await stepRepository.saveStep({ scanRunId: resumeScanId, stepName, status: "succeeded", startedAt: capturedAt, completedAt: capturedAt, attempt: 1 });
    }

    const innerSpy = vi.fn(async () => {
      throw new Error("inner scanner must not be invoked for rehydrated steps");
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
    // The fix for Finding #3 is asserted here: the orchestrator MUST NOT
    // write a duplicate row per (scanRunId, stepName) just to mark a
    // step as rehydrated. The persisted trail has exactly one row per
    // seeded step after the resume.
    const resumedSteps = await stepRepository.listForRun(resumeScanId);
    for (const stepName of ["fetch_markets", "fetch_books", "normalize_markets"] as const) {
      const rows = resumedSteps.filter((s) => s.stepName === stepName);
      expect(rows).toHaveLength(1);
    }
    expect(resumed.status).toBe("succeeded");
    // The inner scanner is not invoked for the seeded steps, so the
    // repository totals are unchanged from the first run.
    expect(innerSpy).not.toHaveBeenCalled();
    expect(repository.opportunities.length).toBe(opportunitiesAfterFirst);
    expect(repository.orderbookSnapshots.length).toBe(snapshotsAfterFirst);
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

  it("treats step rows as idempotent: re-saving a succeeded step is a no-op", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();
    const { scanner, stepRepository: steps } = buildResumableScanner(repository, stepRepository);

    const result = await scanner.runOnce();
    const completed = await steps.listForRun(result.id);
    const fetchMarketsRows = completed.filter((s) => s.stepName === "fetch_markets");
    expect(fetchMarketsRows).toHaveLength(1);

    // Re-saving the same succeeded step must not create a duplicate row.
    await stepRepository.saveStep(fetchMarketsRows[0]);
    const after = await steps.listForRun(result.id);
    expect(after.filter((s) => s.stepName === "fetch_markets")).toHaveLength(1);
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
});
