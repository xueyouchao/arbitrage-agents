import { Module } from "@nestjs/common";
import { ApiModule } from "./contexts/api/api.module";
import { AppConfigModule } from "./config/config.module";
import { ObservabilityModule } from "./contexts/observability/observability.module";

@Module({
  imports: [AppConfigModule, ObservabilityModule, ApiModule]
})
export class ApiAppModule {}
