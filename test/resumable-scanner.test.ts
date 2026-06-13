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

  it("skips a fully-succeeded resume without invoking the inner scanner", async () => {
    const repository = new InMemoryScannerRepository();
    const stepRepository = new InMemoryScanStepRepository();

    // First run produces real persisted artifacts (snapshots, opportunities).
    const { scanner: firstScanner } = buildResumableScanner(repository, stepRepository);
    const first = await firstScanner.runOnce();
    expect(first.status).toBe("succeeded");
    const opportunitiesAfterFirst = repository.opportunities.length;
    const snapshotsAfterFirst = repository.orderbookSnapshots.length;

    // Resume under a fresh scan id; all six steps are pre-seeded as
    // succeeded so the orchestrator has nothing to execute.
    const resumeScanId = "scan-resume-1";
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
    const resumedSteps = await stepRepository.listForRun(resumeScanId);
    expect(resumedSteps.map((s) => s.stepName)).toEqual(RESUMABLE_SCAN_STEP_NAMES);
    expect(resumedSteps.filter((s) => s.metadata?.rehydrated === true)).toEqual([]);
    // The inner scanner is not invoked when every step is already
    // succeeded, so the repository totals are unchanged from the first run.
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
});
