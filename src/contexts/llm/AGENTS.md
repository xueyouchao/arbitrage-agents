# LLM Context

## Purpose

`src/contexts/llm/` owns optional persisted LLM evaluations used to assist review/classification workflows without authorizing trades.

## Ownership

- LLM evaluation request/record types, gateway behavior, schema validation, caching, and persistence abstractions are owned here.

## Local Contracts

- LLM output must never directly authorize trading or execution behavior.
- Persist prompt version, model, input hash, raw output, parsed output, token usage, cost, latency, and status when available.
- Validate model outputs against task schemas before treating them as structured data.
- Avoid sending raw secrets, credentials, auth headers, DSNs, wallet keys, or unnecessary PII to providers or observability systems.

## Work Guidance

- Version prompts/schemas when behavior changes.
- Prefer cache lookups by stable input hash before provider calls.
- Add tests for invalid JSON, schema failures, provider errors, and cache hits.

## Verification

- Run `npm run typecheck` after interface changes.
- Run `npm test -- llm` or `npm test` after gateway/evaluation behavior changes.

## Child DOX Index

No child DOX files are currently needed here.
