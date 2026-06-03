import { Module } from "@nestjs/common";
import { ApiModule } from "./contexts/api/api.module";
import { AppConfigModule } from "./config/config.module";
import { ScannerModule } from "./contexts/scanner/scanner.module";

@Module({
  imports: [AppConfigModule, ApiModule, ScannerModule]
})
export class AppModule {}
