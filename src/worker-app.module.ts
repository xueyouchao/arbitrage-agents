import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { ScannerModule } from "./contexts/scanner/scanner.module";

@Module({
  imports: [AppConfigModule, ScannerModule]
})
export class WorkerAppModule {}
