import { Injectable } from "@nestjs/common";
import { ReadOnlyScanner } from "./read-only-scanner";

@Injectable()
export class WorkerScanRunner {
  constructor(private readonly scanner: ReadOnlyScanner) {}

  async runOnce(): Promise<void> {
    const result = await this.scanner.runOnce();
    if (result.status === "failed") {
      throw new Error(`Scan failed (${result.failureCategory ?? "unknown"}): ${result.failureReason ?? "unknown"}`);
    }
  }
}
