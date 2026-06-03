import { Global, Module } from "@nestjs/common";
import { loadAppConfig } from "./app-config";

export const APP_CONFIG = Symbol("APP_CONFIG");

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: loadAppConfig
    }
  ],
  exports: [APP_CONFIG]
})
export class AppConfigModule {}
