import { describe, expect, it, vi } from "vitest";
import { AbandonedScanDetector, AbandonedScanDetectorDeps } from "../src/contexts/scanner/abandoned-scan-detector";
import { ScanResult, ScanMetrics } from "../src/contexts/scanner/scanner-result";
import { InMemoryScannerRepository, InMemoryScanStepRepository } from "../src/contexts/scanner/in-memory-scanner-repository";

function scanRun(id: string, status: "running" | "succeeded" | "failed" = "running"): ScanResult {
  const metrics: ScanMetrics = { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 };
  return {
    id,
    status,
    startedAt: "2026-06-04T11:54:00.000Z",
    completedAt: status === "running" ? undefined : "2026-06-04T11:55:00.000Z",
    metrics
  };
}

function buildDeps(overrides: Partial<AbandonedScanDetectorDeps> = {}): AbandonedScanDetectorDeps & {
  repository: InMemoryScannerRepository;
  stepRepository: InMemoryScanStepRepository;
} {
  const repository = new InMemoryScannerRepository();
  const stepRepository = new InMemoryScanStepRepository();
  return {
    repository: repository as unknown as AbandonedScanDetectorDeps["repository"],
    stepRepository: stepRepository as unknown as AbandonedScanDetectorDeps["stepRepository"],
    abandonedAfterMs: 5 * 60 * 1000,
    now: () => new Date("2026-06-04T12:00:00.000Z"),
    heartbeatOf: async (run) => {
      const steps = await stepRepository.listForRun(run.id);
      const latest = steps.reduce<string | undefined>((acc, s) => {
        if (!s.completedAt) return acc;
        if (!acc) return s.completedAt;
        return s.completedAt > acc ? s.completedAt : acc;
      }, undefined);
      return latest ?? run.startedAt;
    },
    ...overrides
  } as AbandonedScanDetectorDeps & {
    repository: InMemoryScannerRepository;
    stepRepository: InMemoryScanStepRepository;
  };
}

describe("AbandonedScanDetector", () => {
  it("marks running scans without a recent heartbeat as abandoned", async () => {
    const deps = buildDeps();
    deps.repository.saveScanRun(scanRun("stuck-1", "running"));
    deps.repository.saveScanRun(scanRun("healthy-1", "running"));
    deps.repository.saveScanRun(scanRun("done-1", "succeeded"));

    // Seed heartbeat signals: stuck-1 has a step completed 10 minutes ago;
    // healthy-1 has a step completed 1 minute ago; done-1 is filtered out
    // by the running-only predicate.
    await deps.stepRepository.saveStep({ scanRunId: "stuck-1", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-06-04T11:50:00.000Z", completedAt: "2026-06-04T11:50:00.000Z", attempt: 1 });
    await deps.stepRepository.saveStep({ scanRunId: "healthy-1", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-06-04T11:59:00.000Z", completedAt: "2026-06-04T11:59:00.000Z", attempt: 1 });

    const detector = new AbandonedScanDetector(deps);
    const abandoned = await detector.markAbandoned();

    expect(abandoned.map((r) => r.id)).toEqual(["stuck-1"]);
    const stored = deps.repository.scanRuns.find((r) => r.id === "stuck-1");
    expect(stored?.status).toBe("abandoned");
    expect(stored?.metrics.failureCategory).toBe("abandoned");
    expect(stored?.metrics.failureReason).toContain("5m");
  });

  it("leaves scans with a recent heartbeat alone", async () => {
    const deps = buildDeps();
    deps.repository.saveScanRun(scanRun("alive-1", "running"));
    await deps.stepRepository.saveStep({ scanRunId: "alive-1", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-06-04T11:59:30.000Z", completedAt: "2026-06-04T11:59:30.000Z", attempt: 1 });
    const detector = new AbandonedScanDetector(deps);
    const abandoned = await detector.markAbandoned();
    expect(abandoned).toEqual([]);
  });

  it("does not touch completed (succeeded or failed) scans", async () => {
    const deps = buildDeps();
    deps.repository.saveScanRun(scanRun("done-failed", "failed"));
    deps.repository.saveScanRun(scanRun("done-succeeded", "succeeded"));
    const detector = new AbandonedScanDetector(deps);
    const abandoned = await detector.markAbandoned();
    expect(abandoned).toEqual([]);
  });

  it("uses the latest step completedAt as the heartbeat signal", async () => {
    const deps = buildDeps();
    deps.repository.saveScanRun(scanRun("stuck-2", "running"));
    // A 10-min-old step is followed by a 1-min-old step — heartbeat is
    // fresh, so the scan is NOT abandoned.
    await deps.stepRepository.saveStep({ scanRunId: "stuck-2", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-06-04T11:50:00.000Z", completedAt: "2026-06-04T11:50:00.000Z", attempt: 1 });
    await deps.stepRepository.saveStep({ scanRunId: "stuck-2", stepName: "fetch_books", status: "succeeded", startedAt: "2026-06-04T11:59:00.000Z", completedAt: "2026-06-04T11:59:00.000Z", attempt: 1 });
    const detector = new AbandonedScanDetector(deps);
    const abandoned = await detector.markAbandoned();
    expect(abandoned).toEqual([]);
  });

  it("returns the abandoned scan ids so the worker can re-queue them", async () => {
    const deps = buildDeps();
    deps.repository.saveScanRun(scanRun("a"));
    deps.repository.saveScanRun(scanRun("b", "running"));
    deps.repository.saveScanRun(scanRun("c", "running"));
    const detector = new AbandonedScanDetector(deps);
    const abandoned = await detector.markAbandoned();
    expect(new Set(abandoned.map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
  });
});

vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return actual;
});
