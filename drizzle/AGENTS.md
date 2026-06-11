# Drizzle Migrations

## Purpose

`drizzle/` contains committed SQL migrations and Drizzle metadata generated from `src/db/schema.ts`.

## Ownership

- Migration SQL files and `drizzle/meta` snapshots/journal are owned here.
- The source schema is owned by `src/db/AGENTS.md`.

## Local Contracts

- Prefer generating new migrations from `src/db/schema.ts` using the existing npm scripts.
- Do not casually edit historical migrations after they have been shared or applied.
- Keep `drizzle/meta` synchronized with generated migrations.
- Do not create child DOX files under `drizzle/meta`; it is generated tool metadata.

## Work Guidance

- Review generated SQL before committing it.
- Call out destructive changes, required backfills, and assumptions about empty/disposable databases.
- Keep acceptance seed data compatible with current migrations.

## Verification

- Run `npm run db:generate` when deriving migrations from schema changes.
- Run `npm run test:acceptance` against a disposable Postgres database for migration/API persistence changes.

## Child DOX Index

No child DOX files are currently needed here.
