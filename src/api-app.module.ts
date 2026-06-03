import { Module } from "@nestjs/common";
import { ApiModule } from "./contexts/api/api.module";
import { AppConfigModule } from "./config/config.module";

@Module({
  imports: [AppConfigModule, ApiModule]
})
export class ApiAppModule {}
