# Source Runtime

## Purpose

`src/` contains the NestJS application source for the read-only arbitrage scanner: runtime bootstraps, API/worker modules, configuration, database schema, and bounded contexts.

## Ownership

- Source-wide runtime composition is owned here.
- Context-specific rules live under `src/contexts/AGENTS.md` and its children.
- Configuration rules live in `src/config/AGENTS.md`; database schema rules live in `src/db/AGENTS.md`.

## Local Contracts

- Keep API and worker runtime composition separate: `api-app.module.ts` wires API-facing read modules, while `worker-app.module.ts` wires scanner/worker modules.
- Treat `app.module.ts` as legacy combined wiring unless the project deliberately restores a single-process runtime.
- Prefer Nest modules, providers, and dependency injection over ad-hoc singleton wiring.
- API paths should read persisted state; scanner/worker paths perform venue fetches and scan orchestration.
- Do not introduce order placement, trading execution, custody, or autonomous trading side effects anywhere under `src/`.

## Work Guidance

- Put shared environment parsing in `src/config`, persistent schema in `src/db`, and business behavior under `src/contexts`.
- Keep bootstraps thin; move behavior into injectable services or pure domain functions.
- When changing module wiring, check both API and worker entry points for unintended coupling.

## Verification

- Run `npm run typecheck` after TypeScript API or module-boundary changes.
- Run `npm test` for behavioral changes.
- Run `npm run build` when changing NestJS module wiring or entry points.

## Child DOX Index

- `config/AGENTS.md` — environment validation and redaction contracts.
- `contexts/AGENTS.md` — bounded-context architecture and local context indexes.
- `db/AGENTS.md` — Drizzle schema and persistence contracts.
