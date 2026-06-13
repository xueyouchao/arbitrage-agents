  You had asked for a review of the current MVP against:

  - docs/PRD.md
  - docs/ADR.md

  I ran separate passes for:

  - architecture/code quality
  - tests/build/coverage
  - production-readiness planning

  Main conclusion

  The current MVP is a solid read-only arbitrage intelligence scanner scaffold, but it is not production-ready yet.

  Most important finding:

  ▎ The live scanner currently cannot produce real opportunities because both production venue orderbook clients return empty arrays.

  Verification from that review

  These passed:

  npm test
  npm run typecheck
  npm run build

  Observed result:

  Test Files  6 passed (6)
  Tests       19 passed (19)

  Coverage failed because this dependency was missing:

  @vitest/coverage-v8

  High-severity blockers identified

  1. Production scanner cannot produce opportunities
    - KalshiPublicVenueClient.listOrderbooks() returns []
    - PolymarketPublicVenueClient.listOrderbooks() returns []
  2. Orderbook snapshots are not persisted
    - schema has orderbook_snapshots
    - scanner/repository do not meaningfully persist books
  3. LLM pipeline exists but is not integrated
    - persisted LLM gateway exists
    - scan path does not use it
  4. Candidate classification is not persisted
    - A/B/C/D classification exists in domain logic
    - persistence can leave classification fields null
  5. Opportunity risk model is incomplete
    - resolutionRisk always "low"
    - simple fill-risk logic
    - missing staleness/age/snapshot linkage
  6. Fee/slippage/liquidity modeling is too generic
    - one global rate
    - no per-venue model
    - no depth-aware fill simulation

  Immediate next priorities from that conversation

  Recommended engineering order:

  1. Implement real Kalshi and Polymarket orderbook clients.
  2. Persist orderbook snapshots.
  3. Harden HTTP clients with timeout/retry/rate-limit handling.
  4. Persist candidate classifications.
  5. Integrate persisted/schema-validated LLM gateway into the scanner.
  6. Improve opportunity risk/freshness/fee/slippage/liquidity modeling.
  7. Make the worker resumable and wire Sentry check-ins.
  8. Fix coverage tooling and add integration tests.
  9. Harden API tests and response contracts.
  10. Only then launch production read-only analytics.

  Other recent context

  Before that review, you were using the Understand Anything dashboard. The dashboard had started at:

  http://127.0.0.1:5173/?token=[redacted]

  But the background dashboard server was later stopped/killed.

  The transcript file I recovered this from is:

  /home/ubuntu/.claude/projects/-home-ubuntu-repos-arbitrage-agents/52cbe838-25fb-41ee-9984-feaf1f102e8d.jsonl

✻ Churned for 1m 10s

❯ forget about understand anything, could you bring back conversation about the deep review of the MVP implementation

● Yes — ignoring the Understand Anything thread, the latest relevant conversation was the deep review of the MVP implementation.

  Here’s the recovered context.

  ---
  Conversation flow

  I first said I was reviewing the implementation against:

  - docs/PRD.md
  - docs/ADR.md

  with separate passes for:

  - implementation/code review
  - test/build/coverage assessment
  - production-readiness planning

  Then the verification pass completed:

  npm test: passed
  npm run typecheck: passed
  npm run build: passed
  coverage: failed because @vitest/coverage-v8 is missing

  Observed test result:

  Test Files  6 passed (6)
  Tests       19 passed (19)

  Then the implementation review completed with this headline:

  ▎ The code builds and tests pass, but the production scanner currently cannot produce real opportunities because both production venue orderbook clients return empty arrays.

  ---
  Deep Review: MVP Implementation + Production Readiness Plan

  Executive Summary

  The current MVP is a solid domain scaffold for a read-only prediction-market arbitrage intelligence scanner, but it is not production-ready yet.

  Most important finding:

  ▎ The live scanner cannot currently produce real opportunities because both production venue orderbook clients return empty arrays.

  Verification status:

  - npm test — passed
  - npm run typecheck — passed
  - npm run build — passed
  - coverage run — failed because @vitest/coverage-v8 is missing

  Recommendation:

  ▎ Request changes before any production analytics launch. Keep the system read-only/paper-only until the production gates are met.

  ---
  What the system is supposed to be

  The project should be reviewed as a read-only arbitrage intelligence scanner, not a trading bot.

  Expected flow:

  1. Fetch Kalshi + Polymarket public market/orderbook data.
  2. Persist raw venue payloads.
  3. Normalize markets into common domain fields.
  4. Generate deterministic candidate pairs before LLM calls.
  5. Use persisted, schema-validated LLM assistance for ambiguous normalization/equivalence/explanations.
  6. Classify candidate pairs as A/B/C/D.
  7. Calculate both arbitrage hedge directions.
  8. Persist opportunities.
  9. Serve opportunities through an API that reads only from Postgres.
  10. Alert/human-review only; no autonomous execution.

  ---
  High-severity findings

  1. Production scanner cannot produce opportunities

  Files referenced:

  - src/contexts/venues/infrastructure/http-venue-clients.ts
  - src/contexts/scanner/read-only-scanner.ts

  Both production orderbook clients return empty arrays:

  KalshiPublicVenueClient.listOrderbooks()
  PolymarketPublicVenueClient.listOrderbooks()

  Because of that, the scanner has no orderbooks to calculate against, so it cannot emit real production opportunities.

  Required fix

  Implement real venue orderbook ingestion for:

  - Kalshi
  - Polymarket CLOB

  and normalize:

  - top-of-book prices
  - market IDs
  - depth/liquidity
  - timestamps
  - raw payloads
  - source latency/freshness

  ---
  2. Orderbook snapshots are not persisted

  Schema has orderbook_snapshots, but the scanner does not meaningfully persist orderbooks before calculating opportunities.

  Impact:

  - no audit trail
  - no reproducibility
  - no source snapshot link
  - no way to prove why an opportunity existed
  - violates PRD persistence requirements

  Required fix

  Add something like:

  saveOrderbookSnapshots(scanRunId, books)

  Persist:

  - venue
  - venue market ID
  - normalized market reference
  - raw orderbook payload
  - captured timestamp
  - YES/NO ask prices
  - available liquidity
  - stale flag
  - source latency
  - scan run ID

  ---
  3. LLM pipeline exists but is not integrated

  A persisted LLM gateway exists, but the production scan path does not call it.

  So these PRD requirements are currently missing or incomplete:

  - LLM-assisted normalization
  - equivalence comparison
  - adversarial critique
  - explanation generation
  - persisted LLM artifacts
  - schema validation retry/observability
  - token/cost/latency tracking

  Required fix

  Integrate LLM after deterministic prefiltering:

  1. Deterministic normalization first.
  2. Low-confidence markets go to LLM normalization.
  3. Deterministic candidate generation.
  4. Ambiguous/similar pairs go to LLM equivalence/explanation.
  5. Deterministic policy remains final authority.
  6. Persist every LLM call.

  ---
  4. Candidate classification is not persisted

  Domain classification exists, but persistence appears incomplete.

  Specifically, A/B/C/D classification and decision fields can remain null.

  Impact:

  - candidate decisions are not auditable
  - API cannot reliably expose final classification
  - humans cannot reconstruct why a pair was accepted/rejected

  Required fix

  Persist enriched candidate-pair decisions:

  - equivalence class
  - decision
  - deterministic reason codes
  - LLM decision/explanation if used
  - classification timestamp
  - human-review flag
  - prompt/model version if LLM-assisted

  ---
  5. Opportunity risk model is incomplete

  Issues found:

  - resolutionRisk is always "low"
  - fillRisk is simplistic
  - no explicit dataStalenessMs
  - no explicit opportunityAgeMs
  - no robust mismatch risk signal
  - no link to exact source snapshots

  Impact:

  ▎ Opportunities can look safer than they really are.

  Required fix

  Add and compute:

  - dataStalenessMs
  - opportunityAgeMs
  - resolutionRisk
  - fillRisk
  - liquidityRisk
  - venueRisk
  - equivalenceRisk
  - lastVerifiedAt
  - snapshot IDs used
  - calculation version/config version

  ---
  6. Fee/slippage/liquidity modeling is too generic

  Current modeling uses a global rate and simplistic liquidity calculation.

  Impact:

  ▎ Not conservative enough for production analytics or realistic paper trading.

  Required fix

  Introduce:

  - per-venue fee models
  - side-specific fee assumptions
  - top-of-book and multi-level depth calculations
  - target-notional fill simulation
  - partial-fill sensitivity
  - min-edge threshold after conservative assumptions
  - gross/net edge at multiple notionals

  ---
  Medium-severity findings

  1. HTTP clients lack timeouts, retries, and rate-limit handling

  Current fetch() calls lack:

  - timeout
  - retry
  - backoff
  - jitter
  - 429 handling
  - structured venue errors

  Required fix:

  - HTTP adapter with AbortController
  - bounded exponential backoff
  - explicit 429/5xx behavior
  - per-venue request metrics

  ---
  2. Worker is one-shot, not resumable

  The worker runs one scan and exits.

  Missing:

  - persisted step state
  - retryable scan phases
  - abandoned scan detection
  - Sentry check-ins
  - metrics for markets/books/candidates/LLM/opportunities/rejections

  ---
  3. Normalization is too narrow for MVP crypto markets

  Issues:

  - deadline parsing limited
  - touch/any-time semantics are not clearly preserved
  - market phrasing/timezone handling is limited
  - valid markets may be silently dropped before LLM review

  Required fix:

  - preserve touch/any-time semantics
  - parse deadlines from venue raw fields when possible
  - expand BTC/ETH phrase support
  - route low-confidence normalized markets to LLM instead of dropping silently

  ---
  Test findings

  Current covered areas

  Existing tests cover some useful pure-domain behavior:

  - matching happy path
  - deadline tolerance
  - deterministic equivalence classification
  - basic crypto normalization
  - basic opportunity calculation
  - scanner happy path with static dependencies
  - config validation/redaction
  - LLM gateway cache/malformed-output behavior

  Major missing tests

  High-priority gaps:

  1. Coverage tooling
  2. API endpoint tests
  3. Postgres repository tests
  4. Venue ingestion tests
  5. Scanner reliability tests
  6. Opportunity calculator edge cases
  7. LLM persistence/observability tests
  8. Schema/migration tests

  ---
  Production readiness roadmap

  Phase 0 — Baseline stabilization

  Lock scope as:

  - read-only intelligence
  - no order placement
  - no wallet signing
  - no autonomous execution

  Gate:

  - no production deployment can place orders
  - readiness checklist exists
  - tests/build/typecheck green

  ---
  Phase 1 — Real production ingestion

  Implement:

  - real Kalshi orderbook client
  - real Polymarket CLOB orderbook client
  - raw market snapshot persistence
  - raw orderbook snapshot persistence
  - HTTP timeout/retry/rate-limit handling
  - stale/malformed data flags

  Gate:

  - orderbook clients no longer return []
  - every opportunity traces to persisted snapshots
  - stale/missing books block approval
  - venue fixture integration tests pass

  ---
  Phase 2 — Matching, LLM, classification persistence

  Implement:

  - LLM gateway integration into scanner
  - persisted LLM evaluations
  - persisted candidate classification
  - deterministic approval policy
  - LLM fan-out/cost limits
  - cache behavior by input/prompt/model

  Gate:

  - A/B/C/D classifications are persisted
  - LLM decisions have audit trails
  - invalid LLM output is retryable/observable
  - LLM cannot override hard deterministic mismatches

  ---
  Phase 3 — Opportunity risk upgrade

  Implement:

  - complete risk fields
  - venue-specific fee models
  - depth-aware slippage/liquidity
  - source snapshot IDs
  - paper-trade simulation records
  - calculation version/config version

  Gate:

  - no opportunity emits without freshness/risk fields
  - net edge is after conservative assumptions
  - stale/empty books produce no approved opportunity
  - humans can trace every opportunity to exact inputs

  ---
  Phase 4 — Resumable worker and observability

  Implement:

  - persisted scan step status
  - resumable failed scans
  - idempotent steps
  - Sentry check-ins
  - metrics
  - operational runbooks

  Gate:

  - worker resumes partial failed scan
  - reruns do not duplicate records
  - Sentry shows job health
  - API serves latest persisted data during worker outage

  ---
  Phase 5 — API production analytics readiness

  Harden:

  - GET /health
  - GET /v1/opportunities
  - GET /v1/opportunities/:id
  - GET /v1/scan-runs/latest
  - GET /v1/markets

  Add:

  - pagination
  - filtering
  - sorting
  - response limits
  - internal access controls
  - freshness/risk fields
  - human-review flags

  Gate:

  - API reads only Postgres
  - API never triggers scans/venues/LLM
  - API integration tests pass
  - raw venue payloads are not public by default

  ---
  Phase 6 — Test coverage, CI, release gates

  Implement:

  - @vitest/coverage-v8
  - coverage thresholds
  - API/Postgres/venue/scanner/LLM integration tests
  - migration smoke tests
  - CI gates

  Gate:

  - coverage measurable
  - CI blocks failed tests/build/typecheck/migrations
  - release cannot accidentally enable live trading

  ---
  Phase 7 — Production analytics launch

  Deploy:

  - managed Postgres
  - API runtime
  - worker runtime
  - migrations
  - Sentry
  - secret management

  Define SLOs:

  - scan success rate
  - max scan duration
  - max data age
  - API availability
  - LLM cost ceiling
  - venue failure thresholds

  Recommended minimum before live-assisted execution:

  - 30 days production analytics
  - ≥95% successful scheduled scans
  - no unresolved critical data-integrity bugs
  - all opportunities traceable to persisted snapshots
  - measured false-positive rate for Class A opportunities
  - meaningful paper-trading sample

  ---
  Phase 8 — Paper-trading validation

  Simulate:

  - both legs
  - partial fills
  - adverse selection
  - orderbook movement between detection and hypothetical execution
  - residual exposure

  Gate:

  - paper results persisted/queryable
  - system distinguishes apparent edge from actionable edge
  - human labels show acceptable Class A precision
  - evidence supports whether live trading is worth pursuing

  ---
  Live trading warning from the review

  The review explicitly recommended not starting live trading from the current architecture.

  Before any live-assisted trading, it said you need:

  1. New ADR for live-assisted execution.
  2. Compliance/legal/venue terms review.
  3. Execution architecture separate from scanner.
  4. Human confirmation workflow.
  5. Dry-run mode.
  6. Kill switch.
  7. Immutable execution audit log.
  8. Dedicated execution credentials.
  9. Secret manager usage.
  10. Strong risk controls.
  11. Pre-trade quote refresh.
  12. Partial-fill handling.
  13. Residual exposure tracking.
  14. Reconciliation.
  15. Incident runbooks.
  16. Tiny-notional rollout only.

  ---
  Immediate next priorities

  The final recommended engineering sequence was:

  1. Implement real venue orderbook clients.
  2. Persist orderbook snapshots.
  3. Harden HTTP clients with timeout/retry/rate-limit logic.
  4. Persist candidate classifications.
  5. Integrate persisted/schema-validated LLM gateway into scanner.
  6. Complete opportunity risk/freshness/fee/slippage/liquidity modeling.
  7. Make worker resumable and wire Sentry check-ins.
  8. Fix coverage tooling and add integration tests.
  9. Harden API tests and response contracts.
  10. Only then launch production read-only analytics.
---

## 2026-06-05 architecture cleanup / cross-review implementation update

Completed from `docs/CROSS-REVIEW-ISSUES-AND-IMPROVEMENTS.md` architecture TODOs:

- [x] Move `ScannerRepository` into a neutral scanner port file.
  - Added `src/contexts/scanner/scanner-repository.ts`.
- [x] Make completed scan persistence explicit and atomic.
  - Added `saveCompletedScan` with `CompletedScanArtifacts`.
  - Postgres adapter now writes completed scan artifacts in one transaction.
- [x] Move scanner infrastructure composition out of `WorkerScanRunner`.
  - `ScannerModule` now wires scanner pool, venue clients, repository token, and `ReadOnlyScanner` factory.
  - `WorkerScanRunner` is thin and only invokes the injected scanner.
- [x] Separate API DTO/read models from internal domain entities.
  - Added API-owned `OpportunityReadModel` and `MarketReadModel` contracts in `src/contexts/api/read-models.ts`.
- [x] Persist candidate equivalence decisions.
  - Scanner now produces reviewed candidate-pair artifacts `{ pair, decision }`.
  - Postgres candidate-pair persistence writes `equivalence_class` and `decision`.
- [x] Centralize stable UUID generation.
  - Added shared `src/contexts/shared/stable-id.ts` and replaced local duplicate helpers.
- [x] Move venue HTTP clients to infrastructure boundary.
  - Concrete HTTP clients now live under `src/contexts/venues/infrastructure/`.
  - Removed the unused application compatibility re-export after import search confirmed active source/test imports use the infrastructure path.
- [x] Fix scan timestamp correctness.
  - Scanner now uses a calculation timestamp after orderbook fetch.
  - Successful scan `completedAt` is captured freshly rather than reusing `startedAt`.

Deferred / still open:

- [ ] Broad scanner domain-policy injection remains intentionally deferred as premature abstraction.
- [x] Persist orderbook snapshots as first-class artifacts.
- [x] Integrate persisted/schema-validated LLM gateway into the scanner path.
- [ ] Complete opportunity risk/freshness/fee/slippage/liquidity modeling.
- [ ] Make worker resumable and wire Sentry check-ins.
- [ ] Add Postgres/API integration tests and migration smoke tests.
- [ ] Harden API tests and response contracts.
- [x] Fix coverage tooling with `@vitest/coverage-v8`.

## 2026-06-09 persisted/schema-validated LLM scanner integration update

Completed from the remaining handoff list:

- [x] Integrate persisted/schema-validated LLM gateway into the scanner path.

Implementation summary:

- `ReadOnlyScanner` now accepts an optional scanner LLM gateway dependency.
- Scanner module wiring gates LLM use behind `LLM_ENABLED`; disabled scans make no LLM calls instead of persisting no-op provider failures.
- Enabled scans use a CCR/Ollama-compatible chat provider against `LLM_BASE_URL` / `LLM_MODEL` using the native `/api/chat` request shape.
- Ambiguous / low-confidence normalized markets are routed through persisted `market_normalization` evaluations.
- Schema-validated LLM normalization output is conservatively merged before candidate generation; source identity fields remain deterministic and `llm_normalized` keeps downstream decisions auditable/conservative.
- Ambiguous candidate-pair decisions (`B` / `D`) are routed through persisted `market_equivalence` evaluations.
- Normalized markets and candidate pairs persist nullable `llm_evaluation_id` links for durable auditability.
- Scanner metrics now count persisted LLM evaluations, skipped evaluations, prompt/completion tokens, estimated cost, and aggregate LLM latency.
- `SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN` caps total LLM work per scan; calls remain sequential to avoid provider / DB concurrency fan-out.
- Provider failure text is redacted and bounded before being stored in `llm_evaluations.output`.
- Failed and successful attempts for the same `(task_type, input_hash, prompt_version, model)` cache key now share one stable identity to avoid failed-to-success cache ID drift.

Files changed for this item:

- `src/contexts/scanner/read-only-scanner.ts`
- `src/contexts/scanner/scanner-repository.ts`
- `src/contexts/scanner/scanner-result.ts`
- `src/contexts/scanner/scanner.module.ts`
- `src/contexts/scanner/scanner-tokens.ts`
- `src/contexts/scanner/in-memory-scanner-repository.ts`
- `src/contexts/scanner/postgres-scanner-repository.ts`
- `src/contexts/llm/application/persisted-llm-gateway.ts`
- `src/contexts/llm/infrastructure/ollama-chat-llm-provider.ts`
- `src/contexts/llm/infrastructure/postgres-llm-evaluation-repository.ts`
- `src/db/schema.ts`
- `drizzle/0003_colorful_rockslide.sql`
- `src/config/app-config.ts`
- `test/scanner.test.ts`
- `test/config.test.ts`
- `test/llm-observability.test.ts`
- `test/ollama-chat-llm-provider.test.ts`

Verification completed locally:

- `npm test` — passed, 9 test files / 36 tests.
- `npm run typecheck` — passed.
- `npm run build` — passed.

Review notes:

- TypeScript reviewer pass found production no-op wiring, uncapped total LLM work, ignored normalization output, weak durable audit linkage, and incomplete provider-error redaction.
- Those issues were addressed before the successful verification above.

Git / PR status:

- Work is on branch `integrate-scanner-llm-gateway`.
- Commit and PR creation are still pending.
- Before committing, separate unrelated DOX / `AGENTS.md` files from the scanner LLM task unless the operator explicitly wants those included.

Updated remaining engineering sequence:

1. Complete opportunity risk/freshness/fee/slippage/liquidity modeling.
2. Make the worker resumable and wire Sentry check-ins.
3. Add Postgres/API integration tests and migration smoke tests.
4. Harden API tests and response contracts.
5. Only then launch production read-only analytics.

Production launch gate remains unchanged: do not launch read-only production analytics until the above hardening items pass end-to-end verification against real persistence and API read paths.

## 2026-06-11 xhigh-recall code review of the LLM scanner integration diff

Scope:

- Working-tree changes on branch `integrate-scanner-llm-gateway`, including the untracked LLM scanner integration files added since the 2026-06-09 entry.
- The working tree was used as the review scope because the branch has no configured upstream.
- Review method: 9 review agents (5 correctness / 3 cleanup / 1 altitude) at xhigh effort, with recall-biased 1-vote verification.
- After verification, deduplication, and severity ranking, 15 distinct issues survived. They are listed below in order from most severe to least severe.

Files in scope for the review:

- `src/contexts/scanner/read-only-scanner.ts`
- `src/contexts/scanner/scanner-repository.ts`
- `src/contexts/scanner/scanner-result.ts`
- `src/contexts/scanner/scanner-tokens.ts`
- `src/contexts/scanner/scanner.module.ts`
- `src/contexts/scanner/in-memory-scanner-repository.ts`
- `src/contexts/scanner/postgres-scanner-repository.ts`
- `src/contexts/llm/application/persisted-llm-gateway.ts`
- `src/contexts/llm/infrastructure/ollama-chat-llm-provider.ts`
- `src/contexts/llm/infrastructure/postgres-llm-evaluation-repository.ts`
- `src/db/schema.ts`
- `drizzle/0003_colorful_rockslide.sql`
- `src/config/app-config.ts`
- `test/scanner.test.ts`
- `test/config.test.ts`
- `test/llm-observability.test.ts`
- `test/ollama-chat-llm-provider.test.ts`

Findings (15, most severe first):

- [x] 1. `src/contexts/scanner/read-only-scanner.ts` line 205 — The schema-validated `market_equivalence` LLM result is persisted but never mapped into the candidate-pair decision. For a deterministic B/D pair, an LLM `{ equivalent: true, confidence: 0.95 }` only appends `llm_succeeded` to the original alert_only/human_review decision, so no class-A tradable opportunity is produced. Conversely, `{ equivalent: false }` does not force a reject either.
  - **Status:** Fixed. `decisionWithLlmReason` now promotes a deterministic B pair to class A when LLM agrees with high confidence and all deterministic reasons are in the soft-reason allowlist; D-class downgrades to B (audit-only). See `promoteEquivalenceClass` / `promoteEquivalenceDecision` in `src/contexts/scanner/read-only-scanner.ts`.
- [x] 2. `src/contexts/scanner/read-only-scanner.ts` line 308 — LLM normalization injects `llm_normalized` into every successful normalization's `ambiguityFlags`, and `DeterministicEquivalencePolicy` treats any non-empty flags as class B. Resolved pairs can never become class A, so `OpportunityCalculator` emits no opportunity.
  - **Status:** Fixed. The unconditional `llm_normalized` flag was removed; only field-specific material-flip rejection flags are surfaced via `conservativeNormalizationMerge`.
- [x] 3. `src/contexts/scanner/read-only-scanner.ts` line 301 — LLM null fields overwrite deterministic normalized fields. If the LLM returns null for `threshold`, `operator`, or `deadline` while resolving another field, `applyLlmNormalization` converts those nulls to undefined, and candidate generation no longer matches the market.
  - **Status:** Fixed. `mergeNullableField` preserves the deterministic value when the LLM returns null.
- [x] 4. `src/contexts/scanner/postgres-scanner-repository.ts` line 115 — `saveNormalizedMarkets` overwrites `llm_evaluation_id` with NULL on every later scan that has no current LLM evaluation, erasing the prior audit link. `ON CONFLICT (venue, venue_market_id) DO UPDATE` writes `llm_evaluation_id = excluded.llm_evaluation_id` and the parameter is `review.llmEvaluation?.id ?? null`.
  - **Status:** Fixed. The upsert preserves the prior audit link unless the new candidate evaluation is succeeded AND `isPersisted` (`persistedSuccessfulLlmEvaluationId`).
- [x] 5. `src/contexts/scanner/postgres-scanner-repository.ts` line 158 — Same overwrite pattern in `saveCandidatePairs`: a later scan of the same pair with LLM disabled or skipped nulls out `candidate_pairs.llm_evaluation_id`, losing the prior review provenance.
  - **Status:** Fixed. Same `persistedSuccessfulLlmEvaluationId` guard as #4.
- [x] 6. `src/contexts/scanner/read-only-scanner.ts` line 215 — Cached LLM evaluations are counted as fresh per-scan evaluations. `evaluateWithBudget` increments and adds cached token/latency metrics before knowing the result was a cache hit, so `SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN` can be exhausted by cached rows and later uncached or candidate-pair reviews get skipped.
  - **Status:** Fixed. `ScannerLlmGateway.findCached` runs before fresh/per-task budget checks; cache hits no longer consume the fresh budget or accumulate token/latency metrics. `evaluateWithBudget` also short-circuits on `record.isCacheHit` after a fallback call.
- [x] 7. `src/contexts/llm/application/persisted-llm-gateway.ts` line 112 — LLM numeric strings are rejected rather than mapped/coerced. `z.number()` on `threshold` / `confidence` causes valid responses like `{ "threshold": "100000", "confidence": "0.82" }` to be marked failed and the scanner ignores the result.
  - **Status:** Fixed. `z.coerce.number()` is used for `threshold` and `confidence` in both the default and scanner-owned schemas.
- [x] 8. `src/contexts/llm/infrastructure/ollama-chat-llm-provider.ts` line 61 — Ollama `total_duration: 0` is treated as missing. The falsy mapping `payload.total_duration ? Math.round(...) : Date.now() - startedAt` discards a legitimate zero and inflates latency metrics.
  - **Status:** Fixed. Latency uses an explicit `!== undefined && !== null` guard so a legitimate zero is preserved.
- [x] 9. `src/contexts/scanner/read-only-scanner.ts` line 163 — A single FIFO `LlmScanBudget` lets market-normalization calls starve candidate-pair equivalence reviews. On a scan with 25+ ambiguous markets and one high-value ambiguous pair, the pair never receives the LLM equivalence review the integration was added for.
  - **Status:** Fixed. The budget is split per task family (`maxNormalizationEvaluations` / `maxEquivalenceEvaluations`); an equivalence reserve ensures candidate-pair reviews are not starved by normalization calls.
- [x] 10. `src/contexts/scanner/read-only-scanner.ts` line 289 — LLM normalization output fully replaces material matching fields with no domain-level merge policy or consistency guard. A model flip from `price_below` to `price_above` or a change to `threshold` / `deadline` on one venue can create or suppress cross-venue pairs based on a model hallucination.
  - **Status:** Fixed. `conservativeNormalizationMerge` covers every matching-critical field (topic, eventType, asset, threshold, operator, deadline, timezone, resolutionSource, payoffType); any material flip is rejected with a per-field rejection flag.
- [x] 11. `src/contexts/scanner/read-only-scanner.ts` line 215 — LLM gateway exceptions are not isolated, so optional review can fail the whole scan processing path instead of falling back to deterministic behavior. If the injected gateway throws from cache lookup, persistence, or provider plumbing, the outer processing catch marks the scan failed and skips persisting normalized markets, candidate pairs, orderbook snapshots, and opportunities.
  - **Status:** Fixed. `evaluateWithBudget` wraps the gateway call in try/catch and produces a failed evaluation record; the optional `findCached` lookup is also isolated. Scan processing continues with deterministic behavior.
- [x] 12. `src/contexts/scanner/read-only-scanner.ts` line 306 — Cached `market_normalization` records are trusted without revalidation after the schema expansion. Pre-existing succeeded cache rows in the old shape `{ topic, eventType, confidence, ambiguityFlags }` are returned by `findCached` and cast to the new shape, leaving `payoffType` undefined and violating `normalized_markets.payoff_type NOT NULL`.
  - **Status:** Fixed. `revalidateCachedOutput` revalidates cached rows against the current registry, stamps `payloadSchemaVersion`, and the Postgres repository now round-trips `payload_schema_version` (column added in migration `0005_add_llm_payload_schema_version.sql`).
- [x] 13. `src/contexts/scanner/postgres-scanner-repository.ts` line 133 — Scanner persistence assumes any `ScannerLlmGateway` record already exists in the same Postgres database. A test, alternate provider, or future deployment backed by a different repository will fail the FK on `llm_evaluation_id`, turning optional LLM metadata into a scan-persistence failure.
  - **Status:** Fixed. Migration `0004_drop_scanner_llm_fk.sql` drops the hard FK; `persistedSuccessfulLlmEvaluationId` only links to records the gateway marked `isPersisted`, preventing dangling references.
- [x] 14. `src/contexts/llm/application/persisted-llm-gateway.ts` line 106 — Scanner-specific `market_normalization` schema is hard-coded into the generic persisted LLM gateway. Adding a new scanner-supported asset / event type or changing normalization policy requires modifying shared LLM persistence code instead of a scanner-domain contract, so unrelated LLM tasks inherit scanner schema churn.
  - **Status:** Fixed. Scanner task schemas now live in `src/contexts/llm/scanner-llm-validators.ts`; the generic gateway accepts a domain-owned `LlmOutputValidatorRegistry` via `PersistedLlmGatewayOptions`.
- [x] 15. `src/contexts/llm/infrastructure/ollama-chat-llm-provider.ts` line 81 — LLM response schemas are duplicated between prompt construction (`schemaInstructionFor`) and `PersistedLlmGateway` validation (`schemaForTask`). Updating one side but not the other causes valid-looking model responses to be rejected and recorded as failed evaluations.
  - **Status:** Fixed. The prompt and validator sides both consult `describeScannerSchema` in the scanner-domain contract, so they cannot drift.

Reviewer reachability during the run:

- Codex `gpt-5.5` — 5 of 9 review agents hit the Codex usage limit (429) before returning a verdict, so the findings above are recall-biased (kept) rather than strictly CONFIRMED.
- Ollama Cloud re-runs of the 5 capped agents were attempted via `glm-5.1:cloud` and `deepseek-v4-flash:cloud`, but those agents had no file / Read / grep tool access and produced only generic, hallucinated findings (wrong file paths, invented symbols) that REFUTED against the working tree, so they did not add to the final list.

Next actions implied by these findings:

- Decide whether LLM equivalence output should be allowed to promote a deterministic B/D pair to class A, or must remain advisory. Update `decisionWithLlmReason` to either (a) consult `llmEvaluation.parsedOutput.equivalent` and `confidence` and produce a class-A decision, or (b) document explicitly that LLM equivalence is audit-only.
- Remove the unconditional `llm_normalized` ambiguity flag, or change `DeterministicEquivalencePolicy` to ignore it, so an LLM-clean normalization can still produce a tradable class-A pair.
- Make LLM `null` fields preserve the deterministic value (`existing ?? normalized`) instead of overwriting it, so candidate generation is robust to partial LLM responses.
- Change the upsert conflict update for `normalized_markets.llm_evaluation_id` and `candidate_pairs.llm_evaluation_id` to only set the value when the new review carries an evaluation, so earlier audit links survive scans that skip LLM.
- Distinguish cached vs fresh evaluations in `evaluateWithBudget` so cached rows do not consume the per-scan budget and do not contribute to scan token / latency metrics.
- Coerce LLM numeric strings at the schema boundary (`z.coerce.number()` or a pre-parse map) for `market_normalization` `threshold` and `confidence`, and for `market_equivalence` `confidence`.
- Fix the `total_duration` falsy check to use `??` instead of `?:`.
- Split the LLM budget between normalization and equivalence reviews (or run equivalence first) so candidate-pair LLM reviews are not starved.
- Isolate gateway exceptions in `evaluateWithBudget` so a transient LLM failure cannot fail the whole scan.
- Re-validate cached `market_normalization` records against the current schema before applying them, and either migrate cache rows or scope the cache key by schema / prompt version.
- Have the scanner module own the LLM evaluation repository or stop writing the FK, so a non-Postgres gateway does not break persistence.
- Move the scanner-specific normalization schema out of the generic LLM gateway into a scanner-domain contract, and keep the prompt-side and validator-side response schemas in one place to prevent drift.


Verification for this update:

- `npm test` — passed, 8 test files / 25 tests.
- `npm run typecheck` — passed.
- `npm run build` — passed.

Indexing note:

- GitNexus metadata in `CLAUDE.md` / `AGENTS.md` was refreshed to 652 symbols, 1258 relationships, and 36 execution flows.
- Generated local index artifacts such as `.codegraph/` and `.understand-anything/dashboard.pid` should not be treated as source changes for the PR.

---

## 2026-06-06 PR #2 merge-conflict resolution and multi-review handoff

Merge-conflict resolution status:

- Resolved and staged the PR #2 merge conflicts while preserving the orderbook provenance model.
- Validation passed:
  - `npm run typecheck`
  - `npm test -- test/scanner.test.ts test/stable-id.test.ts`
  - `npm test` — 8 test files / 26 tests passed.
  - `npm run build`
- `npx gitnexus detect-changes --repo arbitrage-agents` was run and returned `No changes detected`.

Reviewer reachability:

- Codex `gpt-5.5` — reachable.
- `minimax-m3:cloud` — reachable.
- `deepseek-v4-flash:cloud` — reachable.
- `glm-5.1:cloud` — reachable.
- `kimi-k2.6:cloud` — reachable.

### Confirmed risks / bugs from reviewers

- [x] **Injected scanner `now` timestamp is ignored for opportunity freshness calculation**
  - Consensus: 5/5 reviewers.
  - Severity: medium.
  - Confidence: high.
  - Files:
    - `src/contexts/scanner/read-only-scanner.ts`
    - `src/contexts/arbitrage/domain/opportunity-calculator.ts`
  - Root cause: `ReadOnlyScannerDependencies.now` is used for `startedAt`, but opportunity freshness uses a separate `calculationAt` derived from `clock ?? new Date()`. If callers pass fixed `now` without also passing `clock`, `OpportunityCalculator.calculate(...)` compares orderbook `capturedAt` values against wall-clock time rather than the intended scan time.
  - Impact: deterministic, replay, backfill, demo, or test scans can silently produce `opportunitiesFound: 0` even when orderbooks are fresh relative to the requested scan timestamp.
  - Completion: fixed in `src/contexts/scanner/read-only-scanner.ts`; `ReadOnlyScanner` now builds one effective clock that honors `clock` first, then fixed `now`, then wall-clock time. Added scanner regression coverage for fixed `now` freshness.

- [x] **Persisted opportunity row IDs included per-run snapshot IDs**
  - Consensus: 1 reviewer initially reported this as an unconfirmed risk; follow-up verification confirmed it.
  - Severity: medium.
  - Confidence: high after verification.
  - Files:
    - `src/contexts/scanner/read-only-scanner.ts`
    - `src/contexts/scanner/postgres-scanner-repository.ts`
  - Verified root cause: orderbook snapshot IDs include the per-run `scanId`, and `saveOpportunities(...)` derived the persisted opportunity primary key from `opportunity.id` plus both source snapshot IDs.
  - Impact: the same market opportunity would insert as a new row on each scan instead of refreshing `last_verified_at`, duplicating `/v1/opportunities` rows and weakening detected/verified timestamp semantics.
  - Completion: fixed in `src/contexts/scanner/postgres-scanner-repository.ts`; persisted opportunity IDs now derive from scan-independent `opportunity.id`, while the upsert still refreshes the Kalshi/Polymarket source snapshot foreign keys and `last_verified_at` on conflict.

### Unconfirmed risks from reviewers

- [x] Verified and resolved during this follow-up pass; no unconfirmed reviewer risks remain open.

### Architecture suggestions from reviewers

1. **Decouple scanner orchestration from persistence DTO assembly and cross-context domain objects**
   - Priority: high.
   - Files:
     - `src/contexts/scanner/read-only-scanner.ts`
     - `src/contexts/scanner/scanner-repository.ts`
     - `src/contexts/scanner/postgres-scanner-repository.ts`
   - Suggestion: keep `ReadOnlyScanner` as the use-case coordinator, but move artifact/provenance mapping into a `ScanArtifactAssembler`, repository mapper, or narrower persistence ports such as market snapshot, matching decision, orderbook snapshot, and opportunity stores.

2. **Clarify venues boundary and remove infrastructure re-export through the application layer**
   - Priority: medium.
   - Files:
     - `src/contexts/venues/infrastructure/http-venue-clients.ts`
     - `src/contexts/scanner/scanner.module.ts`
     - `test/venue-http-clients.test.ts`
   - Suggestion: delete the compatibility re-export if it is no longer needed, or introduce a `VenuesModule` that exports provider tokens for `VenueClient` ports.

3. **Centralize Postgres pool ownership in shared infrastructure**
   - Priority: medium.
   - Files:
     - `src/contexts/api/postgres-read-repositories.ts`
     - `src/contexts/api/api.module.ts`
     - `src/contexts/scanner/scanner.module.ts`
     - `src/contexts/scanner/postgres-scanner-repository.ts`
   - Suggestion: create a shared database infrastructure module/provider such as `DATABASE_POOL` or `DB_POOL`, inject it into both read and write repositories, and let only that module own `pool.end()`.

4. **Move orderbook/market-book types out of the arbitrage domain so venues do not depend on arbitrage**
   - Priority: high.
   - Files:
     - `src/contexts/venues/domain/venue-market.ts`
     - `src/contexts/venues/infrastructure/http-venue-clients.ts`
     - `src/contexts/arbitrage/domain/opportunity.ts`
     - `src/contexts/scanner/read-only-scanner.ts`
   - Suggestion: define a venue-owned `VenueOrderbookSnapshot` / `MarketQuote` type or a small shared-kernel quote shape, then map to the calculator input at the scanner/application boundary.

5. **Stop exposing internal domain types directly as API read models**
   - Priority: medium.
   - Files:
     - `src/contexts/api/read-models.ts`
     - `src/contexts/api/postgres-read-repositories.ts`
   - Suggestion: define API-local DTO primitives/string unions in `src/contexts/api` and map persisted values explicitly in `PostgresReadRepositories`.

6. **Keep scanner failure policy observable instead of swallowing fetch and persistence errors**
   - Priority: medium.
   - Files:
     - `src/contexts/scanner/read-only-scanner.ts`
     - `src/contexts/scanner/worker-scan-runner.ts`
     - `src/contexts/scanner/scanner-repository.ts`
   - Completion: scanner failures now include sanitized `failureCategory` / `failureReason` on `ScanResult` and `scan_runs.metrics`; `WorkerScanRunner.runOnce()` throws a sanitized error when a scan result fails.

7. **Add immutable opportunity observation history if per-scan provenance is required**
   - Priority: medium.
   - Files:
     - `src/contexts/scanner/postgres-scanner-repository.ts`
     - `src/contexts/api/postgres-read-repositories.ts`
     - `src/contexts/api/read-models.ts`
   - Suggestion: keep `opportunities` as the stable/latest projection keyed by scan-independent opportunity identity for `/v1/opportunities`, and add a separate `opportunity_observations` or `opportunity_history` table keyed by scan run plus source orderbook snapshot IDs for immutable historical provenance.
   - Rationale: putting snapshot IDs back into `opportunities.id` would reintroduce duplicate current opportunities across scans; a separate history table preserves auditability without weakening the current-opportunity de-duplication fix.

---

## 2026-06-12 Phase 4: resumable worker + Sentry check-ins

Worktree: `.claude/worktrees/phase4-resumable-worker` (branch `phase4-resumable-worker`, forked from `main` at `7e30e00`, target PR base `main`).
Commit: `f12457a Phase 4: resumable worker + Sentry check-ins` (24 files, +2532 / -25).
Scope: deliver Phase 4 from the production-readiness roadmap — `Make the worker resumable and wire Sentry check-ins`. `main` was untouched (the only concurrent work on main was a separate worker's GitNexus skill edits and the staged `0006_overconfident_owl` migration; neither was modified by this branch).

### Implementation summary

- `scan_runs.heartbeat_at` column added so the abandoned-scan detector has a cheap freshness signal.
- `scan_steps` table added (`id`, `scan_run_id` FK, `step_name`, `status`, `started_at`, `completed_at`, `attempt`, `failure_reason`, `metadata` jsonb) with composite index `(scan_run_id, step_name, started_at DESC)` for the orchestrator's "latest row per step" lookup. **No unique constraint** (see Finding #2 in the review below) — the orchestrator keeps history.
- Migration: `drizzle/0006_phase4_resumable_worker.sql` (+ `drizzle/meta/0006_snapshot.json`).
- `ResumableScanner` orchestrator (`src/contexts/scanner/resumable-scanner.ts`): six named steps (`fetch_markets`, `fetch_books`, `normalize_markets`, `review_pairs`, `calculate_opportunities`, `finalize`). On `runOnce`, the orchestrator hydrates the existing step trail, skips already-succeeded steps, and delegates the actual scan work to the inner `ReadOnlyScanner` for `fetch_markets` (the inner scanner is idempotent on `(venue, venue_market_id)` upsert keys, so re-running is safe). A Sentry cron-monitor check-in is `start()`'d at the scan boundary and `ok()`/`error()`'d at the end. The orchestrator re-marks rehydrated steps with `metadata.rehydrated: true`.
- `AbandonedScanDetector` (`src/contexts/scanner/abandoned-scan-detector.ts`): finds scan_runs in `running` status whose most recent heartbeat is older than `scannerAbandonedAfterMs` (default 5 min), flips them to `abandoned`, and surfaces a `failureCategory: "abandoned"`. Called once per worker iteration BEFORE the new scan starts.
- `SentryHttpCheckInClient` + `FakeSentryCheckInClient` (`src/contexts/observability/sentry-check-in-client.ts`): the real client posts to the public Sentry envelope endpoint (DSN parsed locally to avoid an `@sentry/node` dependency). The fake is used when `SENTRY_DSN` is unset, so a misconfigured deploy cannot crash the worker on a check-in call.
- `WorkerScanRunner` (`src/contexts/scanner/worker-scan-runner.ts`) now calls `markAbandoned()` then `resumable.runOnce()`.
- `ScannerModule` (`src/contexts/scanner/scanner.module.ts`) wires the new providers (`SCAN_STEP_REPOSITORY`, `SENTRY_CHECK_IN_CLIENT`, `ResumableScanner`, `AbandonedScanDetector`) and conditionally picks the real Sentry client or the fake based on `SENTRY_DSN`.
- `AppConfig` gained `scannerAbandonedAfterMs` (env: `SCANNER_ABANDONED_AFTER_MS`) and `sentryMonitorSlug` (env: `SENTRY_MONITOR_SLUG`).
- API read model (`src/contexts/api/read-models.ts`, `postgres-read-repositories.ts`) widened to surface `"abandoned"` status and `failureCategory`.

### Verification (all green at `f12457a`)

- `npm test` — 13 test files / 68 tests passing (was 8 / 25 before this branch).
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npx drizzle-kit check` — `Everything's fine`.

New tests:
- `test/resumable-scanner.test.ts` (8 tests): full happy-path with all 6 step rows persisted, Sentry lifecycle (in_progress → ok / error), resume-skips-succeeded-steps, rerun-failed-step, idempotent step rows, transport-failure-tolerance, step name list, fake check-in lifecycle.
- `test/abandoned-scan-detector.test.ts` (5 tests): marks stale `running` scans, leaves fresh heartbeats alone, ignores non-running scans, prefers the latest step `completed_at` as the heartbeat signal, returns the full abandoned set for re-queueing.
- `test/sentry-check-in-client.test.ts` (6 tests): DSN parsing, envelope URL/path/body shape, `start` → `ok` / `error` paired with the right `check_in_id`, fake captures all three transitions, `FakeSentryCheckInClient` implements the interface.

Updated tests:
- `test/scanner.test.ts`: the `WorkerScanRunner` ctor is now `(resumableScanner, abandonedDetector)`; one test was updated to match.
- `test/config.test.ts`: asserts `SCANNER_ABANDONED_AFTER_MS` and `SENTRY_MONITOR_SLUG` parse and feed through to `AppConfig`.

### 2026-06-12 xhigh-recall code review of the Phase 4 diff

Scope: working-tree changes on branch `phase4-resumable-worker`, commit `f12457a`. Review method: 7 independent finder angles (3 correctness + 3 cleanup + 1 altitude) at high effort, 1-vote verifier. After dedup and severity ranking, **10 distinct findings** survived. They are listed below in order from most severe to least severe. **Findings #1–#3 are blocking and must be fixed before merge** — the Phase 4 implementation as committed does not run against Postgres. Findings #4–#7 are operational risks. Findings #8–#10 are drift / cleanup.

Files in scope for the review:

- `drizzle/0006_phase4_resumable_worker.sql`
- `drizzle/meta/0006_snapshot.json`
- `src/config/app-config.ts`
- `src/contexts/api/postgres-read-repositories.ts`
- `src/contexts/api/read-models.ts`
- `src/contexts/observability/sentry-check-in-client.ts`
- `src/contexts/scanner/abandoned-scan-detector.ts`
- `src/contexts/scanner/in-memory-scanner-repository.ts`
- `src/contexts/scanner/postgres-scan-step-repository.ts`
- `src/contexts/scanner/postgres-scanner-repository.ts`
- `src/contexts/scanner/resumable-scanner.ts`
- `src/contexts/scanner/scan-step.ts`
- `src/contexts/scanner/scanner-repository.ts`
- `src/contexts/scanner/scanner-result.ts`
- `src/contexts/scanner/scanner-tokens.ts`
- `src/contexts/scanner/scanner.module.ts`
- `src/contexts/scanner/worker-scan-runner.ts`
- `src/db/schema.ts`
- `test/abandoned-scan-detector.test.ts`
- `test/config.test.ts`
- `test/resumable-scanner.test.ts`
- `test/scanner.test.ts`
- `test/sentry-check-in-client.test.ts`

Findings (10, most severe first):

### Blocking (must fix before merge)

- [ ] **#1 — PostgresScanStepRepository.listForRun and getStep are stub throwers, but ResumableScanner.runOnce and AbandonedScanDetector.defaultHeartbeatOf both call them — worker crashes on first scan in production** (CRITICAL)
   - Confidence: high (verbatim).
   - Files:
     - `src/contexts/scanner/postgres-scan-step-repository.ts:27-35`
     - `src/contexts/scanner/abandoned-scan-detector.ts:66-68`
     - `src/contexts/scanner/resumable-scanner.ts:85`
   - Root cause: `listForRun` and `getStep` on the Postgres step repo throw `"PostgresScanStepRepository.listForRun requires a client; use loadRunState(pool, scanRunId) instead"`. The interface in `scan-step.ts` declares them as synchronous row-returning methods, and the orchestrator + detector call them through that interface. The free function `loadRunState` does the real work, but no caller uses it.
   - Impact: a worker wired to the Postgres step repo (the only path NestJS DI produces from `scanner.module.ts`) throws on `markAbandoned()` before any scan executes, and on `ResumableScanner.runOnce()` before any step is written. `main-worker.ts` has no catch around `app.get(WorkerScanRunner).runOnce()`, so the process exits non-zero. Phase 4 is unusable in production.
   - Recommendation: implement `listForRun` and `getStep` on `PostgresScanStepRepository` against `scan_steps` (the in-memory variant is the reference). Add a Nest integration test that boots the worker against a real Postgres and calls `runOnce` twice — this would have caught the stub on first commit. Alternatively, change the interface to be async (`Promise<readonly ScanStepRow[]>`) and remove `loadRunState` as a parallel API.

- [ ] **#2 — Snapshot declares unique index `scan_steps_run_name_unique` on `(scan_run_id, step_name)` with `isUnique: true`, but the migration SQL and `src/db/schema.ts` both omit it — the next `drizzle-kit generate` or restored-from-snapshot DB will 23505 every resume** (CRITICAL)
   - Confidence: high (verified at `drizzle/meta/0006_snapshot.json:855-876`, `drizzle/0006_phase4_resumable_worker.sql`, `src/db/schema.ts:144-171`).
   - Root cause: triple divergence. SQL creates `scan_steps_status_idx`, `scan_steps_run_idx`, `scan_steps_run_name_started_at_idx` (no unique constraint). `src/db/schema.ts` declares the same three non-unique indexes. The snapshot declares an additional `scan_steps_run_name_unique` with `isUnique: true` on `(scan_run_id, step_name)`. The orchestrator's rehydration loop (Finding #3) and the in-memory merge contract both rely on there NOT being a uniqueness constraint today.
   - Impact: the codebase is one `drizzle-kit generate` away from total breakage. The moment anyone re-runs `drizzle-kit generate` from the snapshot, regenerates the migration, or restores a DB the snapshot was applied to, every `saveStep` for an already-succeeded `(run, step)` becomes `23505 unique_violation` and the worker error-storms on every resume. The current `drizzle-kit check` passes only because it does not reconcile snapshot↔SQL drift.
   - Recommendation: decide intent. If the unique constraint is intended (operator dashboards rely on one-row-per-step), add it to `src/db/schema.ts`, emit a fresh migration, AND fix Finding #3 first or you'll just move the breakage to runtime. If not, delete it from the snapshot so future `generate` calls don't re-introduce it.

- [ ] **#3 — Rehydration loop calls `saveStep` 6 times per resume just to merge `rehydrated: true` into metadata, and the main loop already wrote the same `(scan_run_id, step_name)` row in the previous pass — duplicate writes today, 23505 under the intended unique index** (CRITICAL)
   - Confidence: high.
   - Files:
     - `src/contexts/scanner/resumable-scanner.ts:113-158`
     - `src/contexts/scanner/postgres-scan-step-repository.ts:108`
   - Verified root cause: for every step the orchestrator's main loop wrote at lines 132/139, the rehydration loop writes again at line 149 for the SAME `(scan_run_id, step_name)`. Without the unique index (current state, per #2) this silently produces duplicate history rows that break the operator's "latest status per step" expectation, inflate `scan_steps`, and waste 6 INSERTs + 6 heartbeat UPDATEs per resume. With the unique index applied (intended state) every resume throws 23505. The `rehydrated: true` flag is trivially derivable on read (`step.attempt > 1` is the same signal).
   - Recommendation: delete the rehydration write loop. Derive `rehydrated` at read time (e.g. in the API read model or via a derived getter on the in-memory repo). If a unique constraint is genuinely intended, switch `saveStep` to `ON CONFLICT (scan_run_id, step_name) DO UPDATE` so the data shape is enforced rather than hoped-for.

### Operational (high)

- [ ] **#4 — PostgresScanStepRepository does not implement `OnModuleDestroy` but shares `SCANNER_DB_POOL` with `PostgresScannerRepository`, which does and calls `pool.end()` — use-after-end on every graceful shutdown** (HIGH)
   - Confidence: high.
   - Files:
     - `src/contexts/scanner/postgres-scan-step-repository.ts:20`
     - `src/contexts/scanner/postgres-scanner-repository.ts:20-25`
     - `src/contexts/scanner/scanner.module.ts`
   - Root cause: both repos are constructed in `scanner.module.ts` as `@Injectable` providers bound to the same `SCANNER_DB_POOL`. Nest provider destruction order within a module is not guaranteed across siblings. When `PostgresScannerRepository.onModuleDestroy` runs first, it calls `pool.end()`; the next in-flight `saveStep` / `markRunHeartbeat` / `loadRunState` on `PostgresScanStepRepository` throws `Cannot use a pool after calling end on the pool`.
   - Impact: half-written final-step rows, abandoned check-ins, and noisy crash logs on every redeploy. Restarts under load lose the last step's persistence state.
   - Recommendation: move pool ownership to a dedicated provider (e.g. `ScannerDbPoolProvider`) whose `OnModuleDestroy` fires after all consumers, OR lift `pool.end()` into the module's `onApplicationShutdown` so it's ordered relative to all dependents. Neither repo should end a pool it doesn't own. This also matches review Finding #3 from the 2026-06-06 handoff ("Centralize Postgres pool ownership in shared infrastructure") which is still open.

- [ ] **#5 — SentryHttpCheckInClient keeps `activeSlug` / `activeStartedAt` / `lastCheckInId` on instance state and is registered as a Nest singleton — overlapping `runOnce()` invocations race and send the wrong `monitor_slug` to Sentry** (HIGH)
   - Confidence: high.
   - Files:
     - `src/contexts/observability/sentry-check-in-client.ts:70-94, 100-120`
     - `src/contexts/scanner/scanner.module.ts:58-61`
   - Root cause: `scanner.module.ts` registers the client via `useFactory` with no explicit scope (default Nest = singleton). `start()` unconditionally overwrites `activeSlug` / `activeStartedAt` / `lastCheckInId` on the instance. `ok()` / `error()` read those fields to build the envelope.
   - Impact: if two `runOnce()` invocations overlap (a slow scan plus the next scheduler tick, or two adjacent cron monitors), the second `start()` clobbers the first's state, and the first `ok()` / `error()` then submits the WRONG `monitor_slug` to Sentry. Cron monitors silently flap green/red for unrelated jobs; on-call chases ghosts because the dashboard shows monitor A completing when monitor B actually ran.
   - Recommendation: return an opaque handle from `start()` that `ok` / `fail` consume (no instance state at all), OR mark the provider `transient` / request-scoped. Add a test that interleaves two `start` / `ok` pairs and asserts each `ok()` carries the slug it started with.

- [ ] **#6 — WorkerScanRunner.runOnce calls `markAbandoned()` before delegating — a long-running successful scan (>5min) gets flipped to 'abandoned' by the NEXT worker iteration and the dashboard shows a phantom incident** (HIGH)
   - Confidence: medium-high.
   - Files:
     - `src/contexts/scanner/worker-scan-runner.ts:25-26`
     - `src/contexts/scanner/abandoned-scan-detector.ts:67-75`
   - Root cause: `runOnce` calls `markAbandoned()` then `resumable.runOnce()`. `defaultHeartbeatOf` falls back to `run.startedAt` when no step rows exist yet (and even after Finding #1 is fixed, when no step transitions have happened in the current iteration). On any scan that legitimately exceeds the abandon threshold (default 5 min, e.g. an LLM batch), the NEXT worker iteration's `markAbandoned` writes `status='abandoned'` over the still-running row; the original iteration's `saveCompletedScan` then overwrites it with `succeeded`. The operator dashboard transiently shows `abandoned` for a normal completion — alert fires, on-call paged, no actual incident.
   - Recommendation: skip abandon-flagging for runs owned by the active worker. Add a per-worker lease / `owner_id` to `scan_runs` and only flag runs whose owner is not the caller. Add an integration test where one scan exceeds the threshold and the next iteration must NOT flip its status.

### Maintenance (medium / low)

- [ ] **#7 — `markAbandoned`'s `listScanRuns` reads all `scan_runs` up to `limit 1000` with no status filter and filters to 'running' in JS — once `scan_runs` has >1000 rows of any status, older 'running' rows silently fall off the page and never get marked abandoned** (MEDIUM)
   - Confidence: high.
   - Files:
     - `src/contexts/scanner/postgres-scanner-repository.ts:56-68`
     - `src/contexts/scanner/abandoned-scan-detector.ts:42-46`
   - Root cause: query is `select ... from scan_runs order by started_at desc limit 1000` with no `WHERE` clause. The detector filters to `status='running'` in the for-loop.
   - Impact: once `scan_runs` exceeds 1000 total rows (days, not months, in any active environment), the oldest `running` rows pushed past the 1000-row window are never seen by `markAbandoned` — they sit in `running` forever, poison dashboards, and skew abandonment metrics. Also wastes bandwidth pulling terminal rows the JS filter discards.
   - Recommendation: push the filter into SQL: `WHERE status = 'running' ORDER BY started_at ASC LIMIT N`. Drop the JS-side status filter. Consider a composite index on `(status, started_at)` to keep this cheap.

- [ ] **#8 — `sanitizeFailureReason` is a byte-for-byte duplicate of the same function in `read-only-scanner.ts:602` — two copies of a security-sensitive string scrubber will drift** (MEDIUM, security drift hazard)
   - Confidence: high (verbatim copy).
   - Files:
     - `src/contexts/scanner/resumable-scanner.ts:222-229`
     - `src/contexts/scanner/read-only-scanner.ts:602-609`
   - Root cause: both functions apply the same `redactSensitiveText` + URL/token regex chain + 200-char slice, byte-for-byte.
   - Impact: when the next leaked-secret pattern is discovered (a new API key prefix, an OAuth token shape, a partner credential format), the engineer adds it to whichever file they opened first. The scanner path whose copy was not updated then writes unscrubbed secrets straight into `scan_runs.failure_reason`, Sentry events, and operator logs. The class of bug this scrubber exists to prevent gets shipped to prod by inattention, not malice.
   - Recommendation: extract to `src/contexts/observability/redaction.ts` (or a new `src/contexts/shared/sanitize-failure-reason.ts`) and import from both call sites. Add a property-based test covering each pattern so any future split is caught at PR time.

- [ ] **#9 — InMemoryScanStepRepository carries three parallel stores (`rows`, `byRunId`, `heartbeats`) with a hand-maintained `refreshByRunId` invariant — a future `saveStep` path that forgets the helper silently desyncs `listForRun`** (LOW, maintainability)
   - Confidence: high.
   - Files:
     - `src/contexts/scanner/in-memory-scanner-repository.ts:53-127`
   - Root cause: `rows` is canonical; `byRunId` is a derivable filter of `rows`; `heartbeats` is a one-key map shadowing parent-class state. `refreshByRunId` must be called after every `saveStep` to keep `byRunId` consistent.
   - Impact: a future `saveStep` variant (batch insert, retry path, partial-update helper) that forgets `refreshByRunId` leaves `byRunId` stale; unit tests that read through `byRunId` still pass because the helper is called in the existing `saveStep` path, but a new code path silently produces a divergent view. The invariant is load-bearing but unenforced.
   - Recommendation: derive `byRunId` on read (`listForRun = rows.filter(r => r.scanRunId === id)`). Push `heartbeats` up into the parent class or store it on the step row itself so there is one source of truth per concept.

- [ ] **#10 — Test helpers `market()` and `kalshiPolymarketPair()` are duplicated from `test/scanner.test.ts:14` — three lockstep copies that will drift the next time the kalshi market shape changes** (LOW, maintainability)
    - Confidence: high.
    - Files:
      - `test/resumable-scanner.test.ts:11, 22`
      - `test/scanner.test.ts:14, 21`
      - `test/scanner-llm-review-fixes.test.ts`
    - Impact: when the kalshi market shape changes again (twice already this year), the engineer updating tests will fix one or two files and miss the third. The stale test then either passes against new code (false confidence) or fails confusingly on a shape mismatch unrelated to the change under review (lost time, lost trust in the suite).
    - Recommendation: extract to `test/helpers/markets.ts` (or `test/fixtures/kalshi.ts`) and import from every consumer. One source of truth for the fake market shape — let the type system catch shape drift in one place.

### Verification notes

- `npm test` — passed, 13 test files / 68 tests.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npx drizzle-kit check` — passed (`Everything's fine 🐶🔥`); the snapshot/SQL divergence (#2) is a runtime concern, not a `drizzle-kit check` one.

### Recommended next steps before merge

1. **Block merge on Findings #1, #2, #3.** They are mutually reinforcing: #1 makes the prod path throw, #2 is the trap that will explode the moment anyone regenerates the migration, and #3 is the orchestrator pattern that will produce the unique-constraint violations once #2 is corrected. The first three should be fixed together.
2. Address Finding #4 (pool ownership) at the same time as the schema work — both touch `scanner.module.ts` and the new `PostgresScanStepRepository`.
3. Findings #5–#7 are operational risks that should ship in a follow-up PR so the resumable worker is still reviewable as a single coherent feature cut. Findings #8–#10 can wait.
4. Re-run `npm test` / `npm run typecheck` / `npm run build` after the fixes; add an integration test that boots the worker against a real Postgres to catch #1 going forward.
