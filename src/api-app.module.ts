import { Module } from "@nestjs/common";
import { ApiModule } from "./contexts/api/api.module";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./contexts/shared/database/database.module";
import { ObservabilityModule } from "./contexts/observability/observability.module";

@Module({
  imports: [AppConfigModule, DatabaseModule, ObservabilityModule, ApiModule]
})
export class ApiAppModule {}
