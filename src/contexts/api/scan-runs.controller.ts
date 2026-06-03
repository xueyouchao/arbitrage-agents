import { Controller, Get } from "@nestjs/common";
import { ScanRunReadService } from "./read-models";

@Controller("v1/scan-runs")
export class ScanRunsController {
  constructor(private readonly scanRuns: ScanRunReadService) {}

  @Get("latest")
  latest() {
    return this.scanRuns.getLatestScanRun();
  }
}
