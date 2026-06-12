// Phase 4: AbandonedScanDetector.
//
// Finds scan_runs in `running` status whose most recent heartbeat is
// older than `abandonedAfterMs`, flips them to `abandoned`, and returns
// their ids so the worker can re-queue them. The detector is the worker
// process's "self-healing" primitive: a previous run that died before
// finalize is recovered by the next run that calls `markAbandoned`.
//
// The heartbeat source is pluggable (`heartbeatOf`) so production can
// query `scan_runs.heartbeat_at` (or the latest `scan_steps.completed_at`)
// and tests can drive the detector with a synthetic clock.

import { ScanResult } from "./scanner-result";
import { ScannerRepository } from "./scanner-repository";
import { ScanStepRepository } from "./scan-step";

export interface AbandonedScanDetectorDeps {
  repository: ScannerRepository;
  stepRepository: ScanStepRepository;
  // Maximum age (ms) of a running scan's heartbeat before it is
  // considered abandoned. Defaults to 5 minutes.
  abandonedAfterMs?: number;
  // Inject for tests. Production callers should use a real clock.
  now?: () => Date;
  // Derive the heartbeat timestamp for a given scan run. Default:
  // fall back to `scan_runs.started_at` (most conservative — a fresh
  // run with no step activity is NOT considered abandoned until the
  // grace period has elapsed from `started_at`).
  heartbeatOf?: (run: ScanResult) => string | undefined | Promise<string | undefined>;
}

export const ABANDONED_AFTER_MS_DEFAULT = 5 * 60 * 1000;

export class AbandonedScanDetector {
  constructor(private readonly deps: AbandonedScanDetectorDeps) {}

  async markAbandoned(): Promise<ScanResult[]> {
    const now = this.deps.now ?? (() => new Date());
    const abandonedAfterMs = this.deps.abandonedAfterMs ?? ABANDONED_AFTER_MS_DEFAULT;
    const heartbeatOf = this.deps.heartbeatOf ?? defaultHeartbeatOf(this.deps.stepRepository);

    const abandoned: ScanResult[] = [];
    const runs = await this.deps.repository.listScanRuns();
    for (const run of runs) {
      if (run.status !== "running") continue;
      const heartbeat = await heartbeatOf(run);
      if (!heartbeat) continue;
      const ageMs = now().getTime() - new Date(heartbeat).getTime();
      if (ageMs < abandonedAfterMs) continue;
      const ageMinutes = Math.round(ageMs / 60_000);
      const thresholdMinutes = Math.round(abandonedAfterMs / 60_000);
      const reason = `abandoned: no heartbeat for ${ageMinutes}m (threshold ${thresholdMinutes}m)`;
      const updated: ScanResult = {
        ...run,
        status: "abandoned",
        completedAt: now().toISOString(),
        metrics: { ...run.metrics, failureCategory: "abandoned", failureReason: reason }
      };
      await this.deps.repository.saveScanRun(updated);
      abandoned.push(updated);
    }
    return abandoned;
  }
}

function defaultHeartbeatOf(stepRepository: ScanStepRepository): (run: ScanResult) => Promise<string | undefined> {
  return async (run) => {
    const steps = await stepRepository.listForRun(run.id);
    const latest = steps.reduce<string | undefined>((acc, s) => {
      if (!s.completedAt) return acc;
      if (!acc) return s.completedAt;
      return s.completedAt > acc ? s.completedAt : acc;
    }, undefined);
    return latest ?? run.startedAt;
  };
}
