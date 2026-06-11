# Scanner Context

## Purpose

`src/contexts/scanner/` owns read-only scan orchestration: venue fetches, normalization, candidate generation, equivalence classification, opportunity calculation, artifact persistence, and worker execution.

## Ownership

- Scanner orchestration services, repository interfaces/implementations, scan-result types, and scanner module wiring are owned here.
- Venue-specific HTTP details, matching rules, arbitrage math, and database schema remain owned by their sibling contexts.

## Local Contracts

- The scanner must remain read-only; never add order placement, trade execution, account mutation, custody, or market-making side effects.
- Preserve failure categorization (`fetch`, `processing`, `persistence`) and useful failure counts.
- Sanitize failure reasons before logging or persistence when they may contain external payloads or configuration.
- Persist complete scan artifacts through `ScannerRepository`; avoid partial writes that break API provenance.

## Work Guidance

- Keep `ReadOnlyScanner.runOnce()` orchestration understandable and delegate detailed calculations to domain services.
- Prefer deterministic test doubles such as in-memory repositories/static venue clients in unit tests.
- When adding persisted fields, update repository interfaces, Postgres implementation, schema/migrations, and API read models together.

## Verification

- Run `npm run typecheck` after repository or module changes.
- Run `npm test -- scanner` or `npm test` after scan behavior changes.
- Run `npm run test:acceptance` for persistence/API provenance changes when a disposable Postgres database is configured.

## Child DOX Index

No child DOX files are currently needed here.
