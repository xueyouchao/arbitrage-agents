# Cross-Review Issues and Architecture Improvements

Date: 2026-06-05

This report consolidates the read-only multi-reviewer bug review and architecture review performed against the `arbitrage-agents` repository. It includes reviewer reachability, bug/risk consensus status, and architecture improvement recommendations.

## Executive Summary

### Bug Review Outcome

No bug reached the requested confirmation threshold of **2+ distinct requested reviewers**. All code-evidenced bug findings are therefore classified as **unconfirmed risk**.

Key unconfirmed risks:

1. ~~Candidate-pair and opportunity persistence may use mismatched stable IDs.~~ **FIXED** — `saveCandidatePairs` now returns the actual persisted DB UUID via `RETURNING id`, and `saveOpportunities` reuses it via `persistedId()` lookup, eliminating FK mismatch.
2. ~~Public opportunity ID semantics may diverge between domain and API/persistence layers.~~ **WONTFIX** — The UUID is a deterministic derivation of the domain ID (`uuidFromStableKey`). The natural API flow (list → get UUIDs → detail lookup by UUID) works correctly. Domain IDs remain internal to the scanner/calculator. If an external integration ever needs domain-ID-based lookup, a `?domain_id=` query param or dual-format accept can be added trivially.
3. ~~Freshly fetched orderbooks can appear to be from the future because scanner start time is reused as calculation time.~~ **FIXED** — `calculationAt` is now captured after all orderbook fetches complete (`read-only-scanner.ts:218`) and passed as `now` to the calculator.
4. ~~Successful scans record `completedAt` as `startedAt`.~~ **FIXED** — `completedAt` is now set via `now()` at save time (`read-only-scanner.ts:324`), producing an accurate completion timestamp.
5. ~~Scan artifact persistence is non-atomic and can leave partial committed database state.~~ **FIXED** — `saveCompletedScan` now wraps all artifact inserts in a single `BEGIN`/`COMMIT` transaction on a dedicated `PoolClient`, with `ROLLBACK` on error.

### Architecture Review Outcome

Architecture review produced stronger consensus. **Four architecture improvements were independently supported by both Minimax M3 and GPT-5.5 architecture reviewers:**

1. Let NestJS DI or a scanner factory own scanner infrastructure composition.
2. Make scan persistence explicit and atomic at the repository boundary.
3. Move `ScannerRepository` into a neutral application/port file.
4. Separate API DTO/read models from internal domain entities.

## Review Methodology

The review followed these guardrails:

- Read-only repository inspection only.
- No file edits during review workflows.
- No installs.
- No full builds.
- Only findings with file/code evidence were retained.
- Single-reviewer bug findings are marked as **unconfirmed risk**.
- Final confirmed bugs require **2+ distinct requested reviewers** reporting the same semantic root cause.

## Reviewer Reachability

| Reviewer | Role | Reachable | Result |
|---|---|---:|---|
| Codex GPT-5.5 | Bug review | Yes | Reachable after CLI fix; returned no code-evidenced bug findings. |
| Minimax M3 | Bug review | Yes | Returned two unconfirmed bug risks. |
| DeepSeek V4 Flash | Bug review | Yes | Returned two unconfirmed bug risks. |
| GLM 5.1 | Bug review | Yes | Prior GLM finding was added per request; one unconfirmed bug risk. |
| Kimi K2.6 | Bug review | Yes | Reachable; returned no bug findings in the consolidated result. |
| Minimax M3 Architecture | Architecture review | Yes | Returned architecture suggestions. |
| GPT-5.5 Architecture | Architecture review | Yes | Returned six architecture suggestions. |

## Bug Findings

### Final Confirmed Bugs

No final confirmed bugs met the requested **2+ reviewer agreement** threshold.

| Consensus | Severity | Bug | Evidence | Impact | Reviewers | Suggested Fix |
|---|---|---|---|---|---|---|
| — | — | None | — | — | — | — |

### Unconfirmed Risks

These findings have code evidence but were each reported by only one requested reviewer. They should be investigated or tested before being treated as confirmed production bugs.

| ID | Severity | Status | Risk | Reviewer | Evidence | Impact | Suggested Fix |
|---:|---|---|---|---|---|---|---|
| R1 | High | **FIXED** | Worker may mark successful opportunity scans as failed due to mismatched `candidate_pair_id` persistence. | Minimax M3 | `src/contexts/scanner/postgres-scanner-repository.ts:84` inserts candidate pairs with `uuidFromStableKey(pair.id)`. `src/contexts/scanner/postgres-scanner-repository.ts:102` inserts opportunities with `candidate_pair_id = uuidFromStableKey(opportunity.pairId)`. `src/db/schema.ts:100` enforces `opportunities.candidate_pair_id` as a foreign key to `candidate_pairs.id`. | If `pair.id` and `opportunity.pairId` ever diverge, opportunity inserts can violate the foreign key and convert an otherwise successful scan into a failed scan. | Persist and reuse the exact persisted candidate-pair primary key for related opportunities. Add a persistence test that inserts a candidate pair and opportunity with FK checks enabled. |
| R2 | Medium | **WONTFIX** | `GET /v1/opportunities/:id` may not accept stable domain opportunity IDs produced by the calculator. | Minimax M3 | Opportunities are persisted with `uuidFromStableKey(opportunity.id)` in `src/contexts/scanner/postgres-scanner-repository.ts:102`. The detail controller validates the path ID as a UUID at `src/contexts/api/opportunities.controller.ts:13`. Domain opportunity IDs are colon-separated strings like `${pairId}:${directionId}` in `src/contexts/arbitrage/domain/opportunity-calculator.ts:106`. | Clients using domain opportunity IDs may be unable to retrieve opportunity details. Public API ID semantics can diverge from domain/in-memory ID semantics. | Choose one public identifier. Either expose/query a persisted domain ID text field, or make the generated UUID the public ID everywhere and keep the domain ID as an internal/external ID. |
| R3 | High | **FIXED** | Scanner passes scan start time as calculator time, making freshly fetched orderbooks appear to be from the future. | DeepSeek V4 Flash | `startedAt` is captured before market and orderbook fetches at `src/contexts/scanner/read-only-scanner.ts:27`, then passed as calculator `now` at `src/contexts/scanner/read-only-scanner.ts:70`. Venue HTTP clients stamp orderbooks after fetching at `src/contexts/venues/infrastructure/http-venue-clients.ts:69` and `src/contexts/venues/infrastructure/http-venue-clients.ts:130`. The calculator rejects books where `now - capturedAt < 0` at `src/contexts/arbitrage/domain/opportunity-calculator.ts:62-69`. | Fresh orderbooks fetched during a scan can be rejected as unusable, producing zero opportunities despite valid market data. | Capture a calculation timestamp after orderbooks are fetched, or allow a small future-skew tolerance in the freshness check. |
| R4 | Medium | **FIXED** | Successful scan records `completedAt` as the scan start time. | DeepSeek V4 Flash | `startedAt` is captured at `src/contexts/scanner/read-only-scanner.ts:27`. Successful scan result uses `completedAt: startedAt` at `src/contexts/scanner/read-only-scanner.ts:77`. Latest scan timestamps are exposed by the API via `src/contexts/api/postgres-read-repositories.ts:104`. | Successful scans report zero duration and inaccurate completion time, reducing monitoring and freshness reliability. | Set `completedAt` to a fresh timestamp immediately before constructing or saving the successful `ScanResult`. |
| R5 | High | **FIXED** | Non-atomic scan persistence can leave partial committed scan data. | GLM 5.1 | `ReadOnlyScanner.runOnce()` persists completed scans through separate awaits for snapshots, normalized markets, candidate pairs, opportunities, and scan run at `src/contexts/scanner/read-only-scanner.ts:87-96`. `PostgresScannerRepository` uses independent `pool.query` calls without a surrounding transaction in `src/contexts/scanner/postgres-scanner-repository.ts:14-139`. | If a later persistence step fails, earlier rows can remain committed while the scan is later marked failed, leaving inconsistent partial scan artifacts in the database. | Persist completed scan artifacts in a single transaction, or expose a coarse `saveCompletedScan`/`saveScanArtifacts` repository method so the adapter owns transaction ordering and `scan_run_id` propagation. |

## Bug Review Notes

- GPT-5.5 was reachable after the CLI fix and returned no code-evidenced bug findings.
- Kimi K2.6 was reachable but returned no retained bug findings in the consolidated result.
- No semantic bug root cause was independently reported by 2+ requested bug reviewers.
- The GLM 5.1 non-atomic persistence issue came from the previous conversation and was explicitly added into this consolidation per request.

## Architecture Improvements

### Architecture Improvements Agreed by 2 Reviewers

These suggestions were independently supported by both Minimax M3 Architecture and GPT-5.5 Architecture reviewers.

| Rank | Priority | Improvement | Reviewers | Evidence | Recommendation | Tradeoff |
|---:|---|---|---|---|---|---|
| 1 | High | Let NestJS DI or a scanner factory own scanner infrastructure composition. | Minimax M3 Architecture, GPT-5.5 Architecture | `WorkerScanRunner` directly constructs a PostgreSQL `Pool`, concrete venue clients, `PostgresScannerRepository`, and `ReadOnlyScanner`. `ScannerModule` only registers `WorkerScanRunner`. Files: `src/contexts/scanner/worker-scan-runner.ts`, `src/contexts/scanner/scanner.module.ts`, `src/worker-app.module.ts`. | Keep `WorkerScanRunner` thin. Register pool, repository, venue clients, and scanner assembly in `ScannerModule` using provider tokens, or inject one small `ScannerFactory` if full provider-token wiring is too much boilerplate. | Adds Nest provider/factory boilerplate, but makes dependency composition explicit and improves testing/configuration. |
| 2 | High | Make scan persistence boundary explicit and atomic for completed scan artifacts. | Minimax M3 Architecture, GPT-5.5 Architecture | `ReadOnlyScanner` coordinates sequential saves; repositories rely on mutable `activeScanRunId` temporal state. Files: `src/contexts/scanner/read-only-scanner.ts`, `src/contexts/scanner/in-memory-scanner-repository.ts`, `src/contexts/scanner/postgres-scanner-repository.ts`. | Prefer a coarse `saveCompletedScan` or `saveScanArtifacts` method for artifacts that are always persisted together, so the repository owns ordering, transaction handling, and `scan_run_id` propagation. | A coarse artifact writer is simpler and transaction-friendly, but can hide fine-grained failure handling. Split ports later only when responsibilities are independently owned. |
| 3 | Medium | Move `ScannerRepository` to a neutral application port. | Minimax M3 Architecture, GPT-5.5 Architecture | `ScannerRepository` is declared in `src/contexts/scanner/in-memory-scanner-repository.ts` and imported by both `PostgresScannerRepository` and `ReadOnlyScanner`. | Create a neutral port file such as `src/contexts/scanner/scanner-repository.ts` or an application-level scanner repository port. Leave `InMemoryScannerRepository` and `PostgresScannerRepository` as adapters implementing it. | Low implementation cost. Helps prevent adapter files from defining core application contracts. |
| 4 | Medium | Separate API DTO/read models from internal domain entities. | Minimax M3 Architecture, GPT-5.5 Architecture | API read models/controllers expose domain types such as `CrossVenueOpportunity` and `NormalizedMarket`; SQL rows are mapped back into domain-shaped objects. Files: `src/contexts/api/read-models.ts`, `src/contexts/api/postgres-read-repositories.ts`, `src/contexts/api/opportunities.controller.ts`, `src/contexts/api/markets.controller.ts`, `src/contexts/matching/domain/normalized-market.ts`. | Define API-context read models/DTOs such as `OpportunitySummaryDto`, `OpportunityDetailDto`, and `MarketDto`. Map SQL rows directly to response contracts. | Adds duplication, but protects public API contracts from domain refactors and lets the API shape evolve independently. |

### Single-Reviewer Architecture Suggestions

These are useful suggestions but had only one architecture reviewer backing them.

| Rank | Priority | Improvement | Reviewer | Evidence | Recommendation | Tradeoff |
|---:|---|---|---|---|---|---|
| 5 | Medium | Persist equivalence decisions as first-class scan output or remove unused schema columns. | Minimax M3 Architecture | `ReadOnlyScanner` computes equivalence decisions, but `saveCandidatePairs` receives only `CandidatePair[]`, and `PostgresScannerRepository` inserts only IDs and reasons. The schema includes candidate-pair decision/classification columns. Files: `src/contexts/scanner/read-only-scanner.ts`, `src/contexts/scanner/postgres-scanner-repository.ts`, `src/db/schema.ts`, `src/contexts/matching/domain/candidate-pair.ts`. | Have the scanner output reviewed-pair artifacts containing `{ pair, decision }`, then persist equivalence class and decision. If intentionally out of scope, remove unused columns. | Persisting decisions improves auditability but adds mapping work. Removing columns is simpler but loses traceability. |
| 6 | Medium | Centralize stable ID generation and choose a consistent persistence mapping style. | Minimax M3 Architecture | The project defines a Drizzle schema, but scanner/API persistence uses handwritten SQL. Stable UUID generation is implemented separately in `PostgresScannerRepository` and `PersistedLlmGateway` with different algorithms. Files: `src/db/schema.ts`, `src/contexts/scanner/postgres-scanner-repository.ts`, `src/contexts/api/postgres-read-repositories.ts`, `src/contexts/llm/application/persisted-llm-gateway.ts`. | Decide whether Drizzle or raw SQL is the project persistence style. In either case, extract stable ID generation into shared infrastructure with a documented algorithm. | Drizzle improves schema/type alignment but may be heavier. Raw SQL remains pragmatic if mappers and ID generation are centralized. |
| 7 | Medium | Inject scanner domain policies rather than constructing them inside `ReadOnlyScanner`. | GPT-5.5 Architecture | `ReadOnlyScanner` constructs `CryptoMarketNormalizer`, `CandidatePairGenerator`, `DeterministicEquivalencePolicy`, and `OpportunityCalculator` as private fields, while only venue clients, repository, and `now` are supplied as dependencies. File: `src/contexts/scanner/read-only-scanner.ts`. | Extend `ReadOnlyScannerDependencies` with optional normalizer, pair generator, equivalence policy, opportunity calculator, ID provider, and clock provider, defaulting to current implementations. | Improves testability and policy substitution, but avoid over-injecting until alternate policies are actually needed. |
| 8 | Low | Treat venue HTTP clients as infrastructure adapters, not application services. | GPT-5.5 Architecture | Historical review finding: HTTP-specific fetch, retry, parsing, and external payload mapping code previously lived under `venues/application`, and `WorkerScanRunner` imported concrete HTTP clients from that path. Current code keeps the concrete clients under `src/contexts/venues/infrastructure/http-venue-clients.ts`, while `src/contexts/venues/application/static-venue-client.ts` remains an application test/support adapter and `src/contexts/venues/domain/venue-market.ts` keeps the `VenueClient` port. | Completed for concrete HTTP clients: keep them in `src/contexts/venues/infrastructure/` while keeping the `VenueClient` port in the domain namespace. | Improves boundary naming; revisit only if the venue client layer grows. |

## Recommended Implementation Order

| Step | Recommendation | Why |
|---:|---|---|
| 1 | ~~Fix scan timestamps: calculation `now` and successful `completedAt`.~~ **DONE** | Small, localized correctness fixes with high observability value. R3 fixed (`calculationAt` captured post-fetch). R4 also fixed (`completedAt: now()` at save time). |
| 2 | ~~Make completed scan persistence atomic.~~ **DONE** | Addresses the strongest cross-cutting data consistency concern and aligns with both bug risk R5 and architecture consensus item 2. R1 also fixed (persisted IDs reused via `RETURNING id` + `persistedId()` lookup). |
| 3 | Move `ScannerRepository` to a neutral port file. | Low-risk cleanup that clarifies boundaries before larger persistence changes. |
| 4 | Move worker dependency construction into Nest providers or a scanner factory. | Simplifies `WorkerScanRunner` and makes scanner tests/configuration easier. |
| 5 | ~~Decide public opportunity ID semantics.~~ **WONTFIX** | UUID is deterministic from domain ID; natural API flow works. Revisit only if external integrations need domain-ID-based lookup. |
| 6 | Separate API DTOs/read models from domain entities. | Useful once API contracts need stability independent of internal domain refactors. |
| 7 | Centralize stable ID generation. | Reduces collision/consistency risks and supports clearer persistence design. |
| 8 | Persist equivalence decisions or remove unused columns. | Improves auditability, but can wait until persistence boundaries are clearer. |
| 9 | Optionally inject scanner domain policies and move venue HTTP clients to infrastructure. | Good DDD cleanup, lower urgency than correctness and persistence work. |

## Open Questions

1. Should API clients use persisted UUIDs, domain stable IDs, or both?
2. Should scan artifacts always be persisted atomically as one completed-scan aggregate?
3. Should persistence standardize on Drizzle or continue with raw SQL plus explicit mappers?
4. Is equivalence-decision auditability required for production/compliance/debugging?
5. Will alternate normalizers/equivalence policies be introduced soon enough to justify dependency injection now?

## Appendix: Consolidated Reviewer Status Fields

```text
codexReachable: true
minimaxM3Reachable: true
deepseekV4Reachable: true
glm51Reachable: true
kimi26Reachable: true
gpt55Issues: []
finalConfirmedBugsTable: []
gpt55ArchitectureReachable: true
```
