import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { ObservabilityModule } from "./contexts/observability/observability.module";
import { ScannerModule } from "./contexts/scanner/scanner.module";

@Module({
  imports: [AppConfigModule, ObservabilityModule, ScannerModule]
})
export class WorkerAppModule {}
