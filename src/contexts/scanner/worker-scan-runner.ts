import { Injectable } from "@nestjs/common";
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
@Injectable()
export class WorkerScanRunner {
  constructor(
    private readonly resumableScanner: ResumableScanner,
    private readonly abandonedDetector: AbandonedScanDetector
  ) {}

  async runOnce(): Promise<void> {
    await this.abandonedDetector.markAbandoned();
    const result = await this.resumableScanner.runOnce();
    if (result.status === "failed") {
      throw new Error(`Scan failed (${result.failureCategory ?? "unknown"}): ${result.failureReason ?? "unknown"}`);
    }
  }
}
