# Documentation

## Purpose

`docs/` contains product, architecture, scope, review, and handoff documentation for the arbitrage scanner.

## Ownership

- ADR, PRD, project scope, cross-review notes, and handoff documents are owned here.
- Source-local agent instructions belong in `AGENTS.md` files, not long-form docs.

## Local Contracts

- Keep the read-only scanner boundary visible; this project is not a trading bot.
- Update ADR/PRD/scope docs when architectural or product boundaries change.
- Document risks around resolution mismatch, partial fills, fees, slippage, liquidity, data freshness, and data redistribution.
- Keep handoff material actionable and current; remove stale operational notes rather than preserving history for its own sake.

## Work Guidance

- Prefer concise, decision-oriented updates over duplicated prose.
- Link implementation changes to docs only when they alter durable contracts or user/operator behavior.
- Do not bury source-code operating rules here if a nearer `AGENTS.md` should own them.

## Verification

- For docs-only changes, inspect rendered Markdown/diff for broken structure.
- Run code tests only when documentation changes accompany behavior changes.

## Child DOX Index

No child DOX files are currently needed here.
