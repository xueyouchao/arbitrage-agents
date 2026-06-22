import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./contexts/shared/database/database.module";
import { ObservabilityModule } from "./contexts/observability/observability.module";
import { ScannerModule } from "./contexts/scanner/scanner.module";

@Module({
  imports: [AppConfigModule, DatabaseModule, ObservabilityModule, ScannerModule]
})
export class WorkerAppModule {}
