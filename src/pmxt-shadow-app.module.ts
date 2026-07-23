import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { ObservabilityModule } from "./contexts/observability/observability.module";
import { PmxtShadowModule } from "./contexts/scanner/pmxt/pmxt-shadow.module";
import { DatabaseModule } from "./contexts/shared/database/database.module";

@Module({
  imports: [AppConfigModule, DatabaseModule, ObservabilityModule, PmxtShadowModule]
})
export class PmxtShadowAppModule {}
