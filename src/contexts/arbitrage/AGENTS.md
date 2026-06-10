# Arbitrage Context

## Purpose

`src/contexts/arbitrage/` owns deterministic opportunity calculation and risk/edge modeling for matched prediction markets.

## Ownership

- Opportunity types and calculator logic are owned here.
- Matching equivalence, venue data fetching, persistence, and API read models are owned by sibling contexts.

## Local Contracts

- Keep calculation deterministic and IO-free.
- Only emit opportunities when equivalence confidence/classification meets the required standard.
- Net edge after fees, slippage, liquidity, and freshness constraints is the meaningful alert metric; gross edge alone is insufficient.
- Do not introduce trade execution, order placement, or portfolio mutation into this context.

## Work Guidance

- Make fee, slippage, freshness, liquidity, and risk defaults explicit and tested.
- Preserve explanatory fields that help operators understand why an opportunity was or was not emitted.
- Add edge-case tests for stale books, missing liquidity, near-threshold edges, and asymmetric fees.

## Verification

- Run `npm run typecheck` after type changes.
- Run `npm test -- arbitrage` or `npm test` after calculator changes.

## Child DOX Index

No child DOX files are currently needed here.
