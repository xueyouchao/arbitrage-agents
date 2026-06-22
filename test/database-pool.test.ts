// Centralized Postgres pool ownership.
//
// The contract being guarded: a single shared infrastructure module
// owns the `DATABASE_POOL` provider and the *only* `pool.end()` call site
// (`DatabasePoolHolder`, via `OnApplicationShutdown`). Neither the API
// read repositories nor the scanner write repositories may construct
// their own `Pool` or call `pool.end()`. This consolidates the
// previously duplicated pool ownership (`PostgresReadRepositories`'s own
// `new Pool` + `OnModuleDestroy`, and the scanner module's
// `SCANNER_DB_POOL` + `ScannerDbPoolHolder`) into one place, so shutdown
// ordering is defined exactly once.

import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DATABASE_POOL } from "../src/contexts/shared/database/database-tokens";
import { DatabasePoolHolder } from "../src/contexts/shared/database/database-pool-holder";
import { DatabaseModule } from "../src/contexts/shared/database/database.module";
import { APP_CONFIG } from "../src/config/config.module";

const poolEnd = vi.fn(async () => undefined);
const poolQuery = vi.fn(async () => ({ rows: [] }));

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({ query: poolQuery, end: poolEnd }))
}));

// A minimal global module that provides + exports APP_CONFIG so
// DatabaseModule's DATABASE_POOL factory (which injects APP_CONFIG) can
// resolve it without pulling in the real loadAppConfig (which reads
// process.env). Mirrors the real AppConfigModule being @Global().
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: { databaseUrl: "postgres://shared-test" } }],
  exports: [APP_CONFIG]
})
class StubConfigModule {}

async function buildModuleRef() {
  return Test.createTestingModule({ imports: [StubConfigModule, DatabaseModule] }).compile();
}

describe("DatabaseModule (shared pool ownership)", () => {
  it("provides DATABASE_POOL constructed from config.databaseUrl", async () => {
    const moduleRef = await buildModuleRef();

    const pool = moduleRef.get<Pool>(DATABASE_POOL);
    expect(pool).toBeDefined();
    expect(Pool).toHaveBeenCalledWith({ connectionString: "postgres://shared-test" });
  });

  it("registers DatabasePoolHolder as the single owner of pool.end() (OnApplicationShutdown)", async () => {
    const moduleRef = await buildModuleRef();

    const holder = moduleRef.get(DatabasePoolHolder);
    expect(holder).toBeInstanceOf(DatabasePoolHolder);

    poolEnd.mockClear();
    await holder.onApplicationShutdown();
    expect(poolEnd).toHaveBeenCalledOnce();
  });

  it("exports DATABASE_POOL so consumer contexts can inject it", async () => {
    const moduleRef = await buildModuleRef();
    expect(moduleRef.get<Pool>(DATABASE_POOL)).toBeDefined();
  });
});