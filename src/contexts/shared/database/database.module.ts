import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../../config/config.module";
import { AppConfig } from "../../../config/app-config";
import { DATABASE_POOL } from "./database-tokens";
import { DatabasePoolHolder } from "./database-pool-holder";

// Shared database infrastructure. The single provider of the Postgres
// connection pool (`DATABASE_POOL`) and the single owner of its lifetime
// (`DatabasePoolHolder`). Imported once by each app module
// (`ApiAppModule`, `WorkerAppModule`); marked `@Global()` so consumer
// modules (`ApiModule`, `ScannerModule`, ...) can inject `DATABASE_POOL`
// without re-importing this module.
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl }),
      inject: [APP_CONFIG]
    },
    {
      provide: DatabasePoolHolder,
      useFactory: (pool: Pool) => new DatabasePoolHolder(pool),
      inject: [DATABASE_POOL]
    }
  ],
  exports: [DATABASE_POOL]
})
export class DatabaseModule {}