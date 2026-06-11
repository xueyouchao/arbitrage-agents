# Database Schema

## Purpose

`src/db/` owns the Drizzle schema for scan runs, venue snapshots, normalized markets, candidate pairs, LLM evaluations, orderbook snapshots, opportunities, alerts, and related persisted artifacts.

## Ownership

- TypeScript schema definitions are owned here.
- SQL migration files and Drizzle metadata are owned under `drizzle/`.
- Repository query behavior is owned by the consuming context.

## Local Contracts

- Schema changes require corresponding committed Drizzle migrations.
- Preserve audit/provenance fields unless a conscious retention or compliance decision changes them.
- Prefer typed normalized columns for API-query-critical fields; use JSONB for raw payload/audit data where appropriate.
- Be careful with IDs, uniqueness constraints, and upsert keys because scanner repositories depend on stable persistence semantics.

## Work Guidance

- Coordinate schema edits with affected repositories, API read models, acceptance seed data, and tests.
- Do not hand-wave data migrations; document destructive or backfill requirements.
- Keep generated migration metadata in sync with generated SQL.

## Verification

- Run `npm run typecheck` after schema type changes.
- Run `npm test` after repository/schema contract changes.
- Run `npm run test:acceptance` when schema changes affect persisted API responses and a disposable Postgres database is configured.

## Child DOX Index

No child DOX files are currently needed here.
