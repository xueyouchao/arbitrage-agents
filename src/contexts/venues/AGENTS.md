# Venues Context

## Purpose

`src/contexts/venues/` owns venue-facing market data abstractions and adapters for public prediction-market APIs.

## Ownership

- Venue market/book types, static clients for deterministic tests, and HTTP venue clients are owned here.
- Cross-venue matching and opportunity calculation are owned by sibling contexts.

## Local Contracts

- Keep venue API quirks isolated inside infrastructure clients.
- Normalize external payloads into explicit `VenueMarketSnapshot` and `MarketBook` structures before other contexts consume them.
- Use bounded timeouts/retries for HTTP fetches; do not introduce unbounded polling or denial-of-service-prone loops.
- Do not leak secrets, auth headers, raw sensitive payloads, or unnecessary API URLs in thrown errors.

## Work Guidance

- Prefer deterministic `StaticVenueClient` fixtures for tests.
- Treat public API schema changes as adapter concerns; keep domain types stable when possible.
- Add tests for malformed or partial external payloads before broadening parsing logic.

## Verification

- Run `npm run typecheck` after type/adapter changes.
- Run `npm test -- venue` or `npm test` after HTTP client or parsing changes.

## Child DOX Index

No child DOX files are currently needed here.
