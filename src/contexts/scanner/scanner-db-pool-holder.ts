// Phase 4: dedicated holder for the scanner module's Postgres pool.
//
// The pool is shared between `PostgresScannerRepository` and
// `PostgresScanStepRepository`. Implementing `OnModuleDestroy` on a
// single repository to call `pool.end()` produced use-after-end errors
// on graceful shutdown, because the sibling consumer's hooks ran in
// undefined order (Phase 4 review Finding #4). This holder is the one
// provider that owns pool lifetime; it implements
// `onApplicationShutdown` (which runs after every module's
// `onModuleDestroy`) so all in-flight consumers have finished their
// last query before the pool is ended.

import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { SCANNER_DB_POOL } from "./scanner-tokens";

@Injectable()
export class ScannerDbPoolHolder implements OnApplicationShutdown {
  constructor(@Inject(SCANNER_DB_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
