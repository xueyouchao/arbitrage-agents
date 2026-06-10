# Matching Context

## Purpose

`src/contexts/matching/` owns market normalization, candidate-pair generation, and deterministic equivalence classification across venues.

## Ownership

- Normalized market types, normalization policies, candidate-pair generation, and equivalence policy rules are owned here.
- Arbitrage edge calculation and venue HTTP fetching are owned by sibling contexts.

## Local Contracts

- Treat equivalence conservatively; ambiguity should lower confidence or require review rather than silently creating strong matches.
- Do not broaden matching rules without tests for resolution source, deadline, threshold, operator, payoff type, and venue-specific wording.
- Keep deterministic reasons/explanations for equivalence decisions.
- Preserve stable IDs for normalized markets and candidate pairs when changing normalization fields.

## Work Guidance

- Keep normalization deterministic and easy to audit.
- Add fixtures for both positive and negative match cases.
- Be explicit when adding non-crypto topics or macro-market handling; do not assume crypto parsing rules generalize.

## Verification

- Run `npm run typecheck` after type changes.
- Run `npm test -- matching` or `npm test` after normalization/equivalence changes.

## Child DOX Index

No child DOX files are currently needed here.
