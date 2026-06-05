import { Injectable } from "@nestjs/common";
import { ReadOnlyScanner } from "./read-only-scanner";

@Injectable()
export class WorkerScanRunner {
  constructor(private readonly scanner: ReadOnlyScanner) {}

  async runOnce(): Promise<void> {
    await this.scanner.runOnce();
  }
}
