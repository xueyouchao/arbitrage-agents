# Tests

## Purpose

`test/` contains Vitest suites for domain/application behavior and curl-based acceptance tests for the built API against a disposable Postgres database.

## Ownership

- Unit/integration-style TypeScript tests and acceptance shell/SQL fixtures are owned here.

## Local Contracts

- Use `npm test` for Vitest suites.
- Use `npm run test:acceptance` only with an explicitly disposable Postgres database; the acceptance script runs migrations and seed SQL.
- Keep acceptance tests black-box HTTP/curl oriented.
- Prefer deterministic fixtures and static clients for scanner, venue, matching, and arbitrage tests.

## Work Guidance

- Update tests with behavior changes, especially API response contracts, persistence provenance, matching equivalence, and opportunity calculation.
- Keep fixtures minimal but representative; include negative cases for conservative matching/risk behavior.
- Avoid tests that depend on live external venue APIs unless explicitly isolated and opt-in.

## Verification

- Run `npm test` for normal changes.
- Run `npm run typecheck` when test helpers/types change.
- Run `npm run test:acceptance` for API/persistence contract changes when disposable DB configuration is confirmed.

## Child DOX Index

No child DOX files are currently needed here.
