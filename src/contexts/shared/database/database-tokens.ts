// Shared database infrastructure token.
//
// `DATABASE_POOL` is the single Postgres connection pool shared by every
// context that talks to Postgres (api read repositories, scanner write
// repositories, LLM evaluation repository, scan-step repository). It is
// provided by `DatabaseModule` and owned by `DatabasePoolHolder`, which
// is the only component permitted to call `pool.end()`.
export const DATABASE_POOL = Symbol("DATABASE_POOL");