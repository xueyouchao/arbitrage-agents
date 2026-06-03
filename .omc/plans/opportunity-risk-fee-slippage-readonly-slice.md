# Opportunity Risk/Fee/Slippage Read-Only Implementation Slice

## Context

This slice converts the current opportunity-calculator subsystem from an implicit heuristic into an explicitly read-only, indicative scanner model with guardrails, clearer risk labels, expanded tests, and usable coverage tooling.

The current implementation should remain non-trading scope. It may surface alert-quality opportunities, but must not introduce execution, order placement, or production trading readiness claims.

## Work Objectives

1. Make opportunity outputs visibly heuristic/read-only to API and persistence consumers.
2. Add calculator guardrails that reject invalid inputs and suppress tiny/noisy positive edges.
3. Improve risk labels using available equivalence and orderbook signals without pretending to model real execution.
4. Expand targeted tests around stale/invalid books, option validation, threshold behavior, scanner no-trade behavior, and risk labels.
5. Add Vitest coverage tooling and exact verification commands.

## Guardrails

### Must Have

- Preserve read-only scanner behavior; no trading, order creation, order submission, execution, signing, or private venue API integration.
- Label outputs as indicative/heuristic/not-for-execution in model/API/persistence-facing surfaces.
- Keep implementation small and compatible with the existing domain model.
- Keep formulas simple unless required for validation/risk labeling; this is not a venue-specific production pricing model.
- Add tests before or alongside behavioral changes.
- Add coverage tooling as an observability gate, not as a claim of trading-system completeness.

### Must NOT Have

- No venue-specific fee schedule modeling unless deferred behind explicit future work.
- No real HTTP orderbook ingestion beyond current read-only/public client behavior.
- No execution workflow, balances, private API keys, orders, fills, or settlement assumptions.
- No broad architecture redesign.
- No misleading names or docs implying executable arbitrage recommendations.

## Ordered Task Flow

### 1. Mark opportunity output as indicative and read-only

Update the domain model and consumer-facing paths so opportunities carry explicit provenance, such as `modelVersion` and/or `estimationNotes`, and API/read models make clear these are heuristic scanner signals.

Relevant files:
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/arbitrage/domain/opportunity.ts`
- `/home/ubuntu/repos/arbitrage-agents/src/db/schema.ts`
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/scanner/postgres-scanner-repository.ts`
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/api/postgres-read-repositories.ts`

Acceptance criteria:
- `CrossVenueOpportunity` includes explicit provenance for the estimation model.
- Persisted/read opportunity records expose this provenance or equivalent not-for-execution metadata.
- Existing opportunity persistence/read tests still pass after schema/read model updates.
- No execution or trading behavior is added.

### 2. Add calculator option validation and edge filtering guardrails

Harden `OpportunityCalculator` construction/calculation around invalid configuration and low-quality opportunities.

Relevant file:
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/arbitrage/domain/opportunity-calculator.ts`

Acceptance criteria:
- `feeRate`, `slippageRate`, and `maxBookAgeMs` must be finite and non-negative before use.
- A configurable minimum net-edge threshold exists, with a safe default that preserves current MVP behavior unless explicitly configured.
- Stale, future-dated, invalid-date, invalid-price, and zero-liquidity books are rejected deterministically.
- Opportunities with `netEdge` at or below the configured threshold are not surfaced.
- Existing valid happy-path opportunities still calculate successfully.

### 3. Improve risk labeling using existing signals

Replace the unconditional `resolutionRisk: "low"` behavior and make `fillRisk` more cautious where current information supports it.

Relevant files:
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/arbitrage/domain/opportunity-calculator.ts`
- `/home/ubuntu/repos/arbitrage-agents/src/contexts/arbitrage/domain/opportunity.ts`

Acceptance criteria:
- `resolutionRisk` is derived from available equivalence confidence/reasons rather than always being `low`.
- `fillRisk` accounts for shallow liquidity and stale/near-stale book age where possible.
- Risk labels remain simple categorical labels; no production execution certainty is implied.
- Tests cover at least low/medium/high risk outcomes or the closest supported categorical set.

### 4. Expand focused unit and scanner tests

Add tests for the new guardrails and read-only semantics before broadening behavior.

Relevant files:
- `/home/ubuntu/repos/arbitrage-agents/test/arbitrage.test.ts`
- `/home/ubuntu/repos/arbitrage-agents/test/scanner.test.ts`

Acceptance criteria:
- Arbitrage tests cover stale books, future `capturedAt`, invalid dates, invalid prices, zero liquidity, invalid fee/slippage options, threshold filtering, both-direction profitability, and risk labels.
- Scanner tests cover missing books, stale books, invalid orderbooks, and explicit no-trade/read-only behavior.
- Tests assert the new provenance/read-only metadata is present where appropriate.
- Targeted Vitest command passes for arbitrage and scanner tests.

### 5. Add coverage tooling and quality gate commands

Make coverage runnable with Vitest and scope it to application source.

Relevant files:
- `/home/ubuntu/repos/arbitrage-agents/package.json`
- `/home/ubuntu/repos/arbitrage-agents/package-lock.json`
- `/home/ubuntu/repos/arbitrage-agents/vitest.config.ts`

Acceptance criteria:
- `@vitest/coverage-v8` is added as a dev dependency compatible with the installed Vitest version.
- `package.json` includes a `test:coverage` script.
- `vitest.config.ts` configures coverage for `src/**/*.ts` and excludes tests/build artifacts as appropriate.
- `npm run test:coverage` completes successfully.

## Exact Verification Commands

Run from the repository root:

```bash
cd /home/ubuntu/repos/arbitrage-agents && npm run typecheck
cd /home/ubuntu/repos/arbitrage-agents && npm test
cd /home/ubuntu/repos/arbitrage-agents && npx vitest run test/arbitrage.test.ts test/scanner.test.ts
cd /home/ubuntu/repos/arbitrage-agents && npm run test:coverage
```

Optional pre-change/current-state check if needed:

```bash
cd /home/ubuntu/repos/arbitrage-agents && npm test -- --coverage
```

Expected current-state note: this currently fails until `@vitest/coverage-v8` is installed.

## Success Criteria

- The subsystem remains read-only and no-trading.
- Opportunity outputs are clearly marked as heuristic/indicative/not-for-execution.
- Invalid options/books are rejected predictably.
- Tiny or noisy positive edges can be filtered via minimum threshold.
- Risk labels no longer imply certainty by always returning low resolution risk.
- Targeted and full tests pass.
- Coverage command is available and passing.

## Deferred / Out of Scope

- Venue-specific Kalshi/Polymarket fee schedules.
- Orderbook depth simulation beyond the current top-level available liquidity fields.
- Real fill modeling, partial fills, settlement/withdrawal costs, or private API integration.
- Production trading readiness claims.
- Real public HTTP orderbook ingestion if current clients still intentionally return empty orderbooks.

## Open Questions

- What venue-specific fee schedule should eventually be modeled for Kalshi and Polymarket, and should fees be charged on cost, payout, profit, or each leg's notional?
- Should `availableUsd` represent spendable quote currency at displayed ask, maximum payout exposure, or a precomputed venue-specific notional?
- What default minimum net edge should be required before alerting?
- Should stale-book max age remain 60 seconds or become venue/config-specific?
- Should public API responses include explicit `readOnly`, `indicative`, or `notForExecution` metadata in addition to model provenance?
