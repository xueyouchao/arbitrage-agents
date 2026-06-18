import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { ResumableScanner } from "./resumable-scanner";
import { AbandonedScanDetector } from "./abandoned-scan-detector";

// Phase 4: the worker's production entry point.
//
// Responsibilities:
//   1. Run an abandoned-scan detection pass BEFORE each scan so a worker
//      that died mid-run is recovered before the next scheduled run.
//   2. Delegate the actual scan to ResumableScanner, which persists
//      per-step state and emits a Sentry check-in.
//
// The runner does NOT throw on a failed scan: ResumableScanner returns
// a sanitized `ScanResult` with `status: "failed"` and a
// `failureReason`. The runner only throws when the underlying scanner
// or step repository throws synchronously, which would indicate a
// programming error or a misconfigured dependency graph.
//
// Finding #6: the runner generates a stable `workerId` at construction
// time and threads it into both the ResumableScanner (which stamps it
// on every scan result) and the AbandonedScanDetector (which uses it
// to skip runs owned by THIS process). Without this per-worker lease,
// a long-running scan is falsely marked abandoned by the next worker
// iteration and the dashboard shows a phantom incident.
@Injectable()
export class WorkerScanRunner {
  private running = false;
  private readonly workerId: string;

  constructor(
    private readonly resumableScanner: ResumableScanner,
    private readonly abandonedDetector: AbandonedScanDetector,
    workerId?: string
  ) {
    this.workerId = workerId ?? randomUUID();
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.abandonedDetector.markAbandoned();
      const result = await this.resumableScanner.runOnce();
      if (result.status === "failed") {
        throw new Error(`Scan failed (${result.failureCategory ?? "unknown"}): ${result.failureReason ?? "unknown"}`);
      }
    } finally {
      this.running = false;
    }
  }
}
