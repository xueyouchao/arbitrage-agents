// Single owner of the shared Postgres pool lifetime.
//
// Consolidates the previously duplicated pool ownership: the api context
// used to construct its own `Pool` and end it in `PostgresReadRepositories`
// `onModuleDestroy`, while the scanner context used `SCANNER_DB_POOL` +
// `ScannerDbPoolHolder`. Both are replaced by this one holder so shutdown
// ordering is defined exactly once.
//
// Implements `OnApplicationShutdown` (which runs after every module's
// `onModuleDestroy`) so all in-flight consumers across both contexts have
// finished their last query before the pool is ended. This is the same
// ordering trick the scanner-side holder already used to avoid the
// use-after-end errors that prompted the original Phase 4 fix.

import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "./database-tokens";

@Injectable()
export class DatabasePoolHolder implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}