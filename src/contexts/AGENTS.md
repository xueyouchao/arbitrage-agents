# Bounded Contexts

## Purpose

`src/contexts/` contains the domain/application/infrastructure boundaries for API read models, scan orchestration, venue adapters, market matching, arbitrage calculation, LLM evaluation, observability, and shared utilities.

## Ownership

- Cross-context architecture rules are owned here.
- Each child context owns its local invariants and verification notes.

## Local Contracts

- Keep domain logic pure where practical; place IO, HTTP, persistence, and framework adapters at context edges.
- Avoid cross-context imports that bypass intended domain/application boundaries.
- Use explicit TypeScript types and Nest DI tokens for runtime interfaces.
- Preserve the read-only scanner boundary: contexts may identify opportunities, but must not execute trades.

## Work Guidance

- Prefer conservative matching and risk decisions over silently broadening opportunity detection.
- Keep provenance fields and explanation strings intact when moving data between contexts.
- When changing shared types, inspect downstream scanner, API read-model, and tests together.

## Verification

- Run `npm run typecheck` after interface or type changes.
- Run `npm test` after domain, scanner, or read-model behavior changes.

## Child DOX Index

- `api/AGENTS.md` — read-only HTTP API and read-model contracts.
- `scanner/AGENTS.md` — scan orchestration, persistence, and failure categorization contracts.
- `venues/AGENTS.md` — public venue API adapter contracts.
- `matching/AGENTS.md` — market normalization, candidate-pair, and equivalence contracts.
- `arbitrage/AGENTS.md` — deterministic opportunity calculation contracts.
- `llm/AGENTS.md` — persisted LLM evaluation contracts.
