import { Module } from "@nestjs/common";
import { WorkerScanRunner } from "./worker-scan-runner";

@Module({
  providers: [WorkerScanRunner],
  exports: [WorkerScanRunner]
})
export class ScannerModule {}
