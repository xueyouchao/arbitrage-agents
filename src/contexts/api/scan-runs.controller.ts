import { Controller, Get, Inject } from "@nestjs/common";
import { ScanRunReadService } from "./read-models";

@Controller("v1/scan-runs")
export class ScanRunsController {
  constructor(@Inject(ScanRunReadService) private readonly scanRuns: ScanRunReadService) {}

  @Get("latest")
  latest() {
    return this.scanRuns.getLatestScanRun();
  }
}
