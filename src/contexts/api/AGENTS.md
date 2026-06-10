# API Context

## Purpose

`src/contexts/api/` exposes read-only HTTP endpoints and read models over persisted scan, market, opportunity, and alert data.

## Ownership

- Controllers, read-model services, API response shapes, and Postgres read repositories are owned here.
- Scanner execution, venue fetching, and LLM calls are not owned here.

## Local Contracts

- API endpoints read persisted data; do not trigger live venue fetches, scans, LLM evaluations, or expensive orchestration synchronously from controllers.
- Validate route parameters and query inputs at controller boundaries.
- Keep response models explicit and stable in `read-models.ts`.
- Preserve provenance fields such as scan IDs, orderbook snapshot IDs, venue IDs, and timestamps.

## Work Guidance

- Favor narrow repository methods that support endpoint use cases without leaking persistence details into controllers.
- Keep health endpoints lightweight and side-effect free.
- Update acceptance tests when changing externally visible routes or response fields.

## Verification

- Run `npm run typecheck` after controller/read-model changes.
- Run `npm test` after read-model behavior changes.
- Run `npm run test:acceptance` for route/response contract changes when a disposable Postgres database is configured.

## Child DOX Index

No child DOX files are currently needed here.
