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
- [ ] Integrate persisted/schema-validated LLM gateway into the scanner path.
- [ ] Complete opportunity risk/freshness/fee/slippage/liquidity modeling.
- [ ] Add Postgres/API integration tests and migration smoke tests.
- [x] Fix coverage tooling with `@vitest/coverage-v8`.

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
