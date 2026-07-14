# Architecture Decision Record: Cross-Venue Arbitrage Intelligence Platform

## ADR-0001: MVP Architecture and Technology Choices

- Status: Accepted
- Date: 2026-06-03
- Project: arbitrage-agents

## 1. Context

The project is being restarted from a narrower and more realistic scope. The previous direction explored crypto/prediction-market latency arbitrage, but review showed that short-window latency strategies are crowded, hard to validate in paper trading, and infrastructure-heavy.

The new scope is a cross-venue prediction-market arbitrage intelligence system focused initially on Kalshi and Polymarket. The system should detect equivalent or near-equivalent markets, calculate fee-adjusted cross-venue opportunities, and provide explainable alerts for human review. The MVP is read-only and must not autonomously trade.

The user prefers Java-style readability, DDD, and dependency injection. The system should remain extensible enough to become a public API/dashboard product later.

## 2. Decision Summary

We will build a DDD-inspired modular monolith using:

- TypeScript
- NestJS
- Postgres
- Drizzle ORM and Drizzle migrations
- Docker Compose for local development/runtime wiring
- Sentry for error, job, and LLM observability
- Postgres-backed resumable jobs initially
- Stateless LLM calls persisted in the database
- Separate API and worker runtimes using the same NestJS application modules

We will not use full microservices, Temporal, Kafka, Flyway, Liquibase, SQLite, autonomous live trading, or IBKR integration for MVP.

## 3. Key Decisions

### 3.1 Product Shape: Arb Intelligence Scanner, Not Trading Bot

Decision: Build a read-only arbitrage intelligence scanner first.

Rationale:

- Starting capital is approximately $50 on Kalshi, so meaningful profit is not the first milestone.
- Cross-venue spreads may be small and can disappear after fees/slippage.
- The hardest risks are market equivalence, partial fills, data staleness, and resolution mismatch.
- Scanner accuracy and historical evidence should be validated before any live-assisted trading.

Consequences:

- MVP emits opportunities and explanations.
- MVP does not place orders.
- Live-assisted execution is deferred until scanner data proves useful.

### 3.2 Strategy Focus: Cross-Venue Crypto First, Macro Second

Decision: Focus first on crypto price-level / longer-window binary markets, then add macro events.

Rationale:

- Crypto markets are easier to automate and appear more frequently.
- BTC/ETH thresholds provide clearer structured fields: asset, threshold, operator, deadline.
- Macro markets may have better risk-adjusted edge but require more nuanced resolution matching.

Consequences:

- First matching policies target BTC/ETH price-level markets.
- Fed/CPI/jobs modules are designed but implemented later.
- 15-minute latency arbitrage is explicitly out of scope.

### 3.3 Architecture Style: DDD-Inspired Modular Monolith

Decision: Use a DDD-inspired modular monolith rather than early microservices.

Rationale:

- The user prefers DDD and dependency injection for readability and extensibility.
- Early microservices would add distributed-systems overhead before the domain is stable.
- A modular monolith provides clear boundaries while preserving easy local development and testing.

Consequences:

- Domain logic remains pure and testable.
- Application use cases coordinate ports/repositories.
- Infrastructure adapters implement venue APIs, DB access, LLM providers, and observability.
- Future extraction into services remains possible if API traffic, worker scale, or live trading requires it.

### 3.4 Framework: NestJS

Decision: Use NestJS as the TypeScript backend framework.

Rationale:

- NestJS supports modules, providers, controllers, dependency injection, constructor injection, and application contexts.
- It is familiar to Java/Spring developers.
- It supports both HTTP APIs and non-HTTP worker processes using the same DI container.

Consequences:

- API entry point and worker entry point can share modules.
- Dependency injection tokens are used for ports/interfaces because TypeScript interfaces do not exist at runtime.
- Code has more structure than a minimal Fastify/Hono app, but better matches the desired design style.

### 3.5 Runtime Separation: API and Worker Containers

Decision: Use separate `api` and `worker` runtime processes/containers, backed by the same codebase and database.

Rationale:

- Scanner jobs can be slow or fail due to venue APIs, rate limits, or LLM calls.
- Public/internal API requests must not trigger expensive scans synchronously.
- This separation maps cleanly from Docker Compose to cloud deployment.

Consequences:

- Worker writes scan results and opportunities to Postgres.
- API reads latest persisted data from Postgres.
- Docker Compose includes postgres, migrate, api, and worker services.

### 3.6 Database: Postgres

Decision: Use Postgres from the start.

Rationale:

- The project may become a public API/dashboard product.
- Postgres supports concurrent API reads and worker writes.
- JSONB is useful for raw venue payloads and LLM input/output.
- Postgres is better than SQLite for future SaaS/API deployment.

Consequences:

- Local development uses Dockerized Postgres.
- MVP cloud database preference is Neon Postgres.
- AWS RDS Postgres is a future production option if AWS becomes the main platform.

### 3.7 Database Migrations: Drizzle Migrations

Decision: Use Drizzle and Drizzle migrations rather than Flyway or Liquibase.

Rationale:

- Drizzle is TypeScript-native and keeps SQL visible.
- Flyway and Liquibase are valid but heavier for a one-language MVP.
- Migrations must be committed to git and run consistently in local, staging, and production.

Consequences:

- Every schema change requires a migration.
- Docker Compose includes a migration step/container.
- Raw venue/LLM payloads are stored in JSONB with queryable normalized columns.

### 3.8 Job Orchestration: Postgres-Backed Resumable Jobs First

Decision: Use simple Postgres-backed scan state and retry fields initially, not Temporal.

Rationale:

- Temporal is powerful but adds infrastructure and workflow-versioning complexity.
- MVP scan steps can be made resumable through tables such as `scan_runs`, `candidate_pairs`, and `llm_evaluations`.
- If future jobs become distributed, long-running, customer-critical, or human-approval-heavy, Temporal can be added later.

Consequences:

- Scan steps must be idempotent where practical.
- Failed LLM evaluations and candidate pair processing can resume from DB state.
- Job design should preserve a clean migration path to Temporal.

### 3.9 LLM Use: Structured Stateless Workers

Decision: Use LLMs for market wording understanding, normalization, equivalence comparison, adversarial critique, and explanation, but not as final trading authority.

Rationale:

- Market matching is the hardest feature and often requires semantic understanding.
- LLMs are useful for interpreting natural-language market descriptions.
- LLMs are risky if allowed to make unbounded trade decisions.
- Context-window explosion is avoided by small stateless calls.

Consequences:

- Every LLM call has a task type, prompt version, input hash, model, schema, persisted input/output, parsed output, token usage, estimated cost, latency, and status.
- Deterministic policy decides final equivalence class and whether an opportunity can alert.
- LLM calls are cached by input hash, prompt version, and model.

### 3.10 Observability: Sentry Plus DB Metrics

Decision: Use Sentry for operational observability and Postgres for audit/source-of-truth logs.

Rationale:

- We need to know when scans fail, LLM calls fail, schema validation fails, or costs spike.
- Sentry supports error tracking, tracing, cron check-ins, logs, and LLM/AI monitoring metrics.
- Full LLM prompts/outputs should not be blindly sent to Sentry.

Consequences:

- Sentry receives metadata, metrics, errors, traces, and redacted/sampled prompt context according to config.
- Postgres stores canonical LLM evaluations and scan records.
- Redaction is mandatory before sending sensitive context to Sentry.

### 3.11 Public API Readiness

Decision: Design for future public API/dashboard by separating scanner writes from API reads.

Rationale:

- A paid product should serve cached, persisted, scored opportunities.
- Public API calls should not synchronously call venues or LLMs.
- Historical opportunity data is valuable for trust, debugging, and customer-facing analytics.

Consequences:

- API endpoints are backed by Postgres.
- Opportunity freshness, age, risk, and confidence are first-class fields.
- Future auth, API keys, tiers, and rate limits can be added without rewriting scanner logic.

## 4. Rejected Alternatives

### 4.1 SQLite

Rejected for MVP because the project may become a public API/dashboard product. SQLite is suitable for a local-only scanner but less suitable for concurrent API + worker workloads and future SaaS deployment.

### 4.2 Self-Hosted Postgres on App Host

Rejected as default production path because it creates backup, failover, security, monitoring, disk, and upgrade responsibilities. Managed Postgres is preferred.

### 4.3 Flyway or Liquibase

Rejected for MVP because they add enterprise-style migration tooling overhead. They remain valid alternatives if the project later needs language-agnostic DBA-controlled migrations.

### 4.4 Early Microservices

Rejected because the domain model and product are not yet stable. Modular monolith gives clearer development speed and easier testing.

### 4.5 Temporal on Day One

Rejected because DB-backed resumable jobs are sufficient for MVP. Temporal may be introduced once workflows become distributed, long-running, or customer-critical.

### 4.6 Autonomous Live Trading

Rejected because market equivalence, fill risk, fee modeling, and scanner reliability must be proven first.

## 5. Initial Module Boundaries

```text
src/
  app.module.ts
  main-api.ts
  main-worker.ts
  contexts/
    venues/
      domain/
      application/
      infrastructure/
    matching/
      domain/
      application/
      infrastructure/
    arbitrage/
      domain/
      application/
      infrastructure/
    scanner/
      application/
      infrastructure/
    llm/
      domain/
      application/
      infrastructure/
    observability/
    api/
  db/
```

## 6. Initial Database Tables

- `scan_runs`
- `venue_market_snapshots`
- `normalized_markets`
- `candidate_pairs`
- `llm_evaluations`
- `orderbook_snapshots`
- `opportunities`
- `alerts`

Raw payloads and LLM artifacts use JSONB. Query-critical fields are normalized into typed columns.

## 7. Security and Compliance Notes

- Do not log secrets, API keys, private keys, wallet keys, auth headers, balances, or customer PII.
- Do not expose raw venue data publicly until venue data redistribution terms are reviewed.
- Include stale-data indicators in any future public API.
- The product must be presented as information/analytics, not financial advice.

## 8. Consequences and Tradeoffs

### Benefits

- Java-friendly architecture and DI.
- Clear DDD boundaries.
- Easy local development through Docker Compose.
- Future-ready API/worker separation.
- Strong persistence/audit trail.
- LLM context explosion avoided through stateless calls and persistence.
- Sentry provides cost/error/latency visibility.

### Costs

- More structure and boilerplate than a script.
- NestJS/DDD requires discipline to avoid over-engineering.
- Postgres and migrations add setup complexity.
- LLM matching requires prompt/version/schema management.
- Public API readiness introduces data-retention and terms-of-service concerns.

## 9. Follow-Up ADRs Expected

Future ADRs should cover:

1. LLM provider/model selection.
2. Prompt schema and retention policy.
3. Neon vs Supabase vs RDS for deployed environment.
4. Public API auth and rate limiting.
5. Whether/when to introduce Temporal.
6. Whether/when to introduce live-assisted trading.
7. Market data redistribution and compliance policy.

---

## ADR-0002: Conditional Settlement-Triggered Exit for Sequential Cross-Venue Opportunities

- Status: Proposed
- Date: 2026-07-10
- Project: arbitrage-agents
- Supersedes: none
- Relates to: ADR-0001 §3.1 (read-only first), §3.2 (crypto price-level first)

## 1. Context

A paired cross-venue opportunity is only a risk-free synthetic when both legs settle against the **same reference at the same time**. The crypto price-level markets surfaced by the scanner do not satisfy this:

- Kalshi KXBTCD settles at **14:00 UTC** against the **CF Benchmarks Real-Time Index**.
- Polymarket `btc-multi-strikes-weekly` settles at **16:00 UTC** against **Binance**.

This creates a **both-lose tail**: if BTC is below the strike at 14:00 (Kalshi YES loses) but above the strike at 16:00 on Binance (Polymarket NO loses), both legs pay zero and the combined position loses its full 0.90 cost. The scanner already records this as `resolution_source_differs_crypto_index` advisory and risk fields `res:medium / equiv:medium`, but the opportunity is still classified `equivalenceClass: A` ("tradable"), which an operator can misread as "risk-free."

The mitigation discussed with the user is to act at `t1` — the settlement time of the **early** (first-settling) leg — on the **surviving** (later-settling) leg, which is still open and tradeable. Two policies were considered:

- **Unconditional exit** — always sell the surviving leg at t1 regardless of the early leg's outcome.
- **Conditional exit** — at t1, sell the surviving leg only when doing so locks a value that beats holding to `t2` by more than the exit cost.

## 2. Decision Summary

Adopt a **conditional settlement-triggered exit**: for every opportunity with sequential settlement (`Δt = |legA.deadline − legB.deadline| > 0`), evaluate the surviving leg at t1 and sell **only when the residual risk justifies the exit premium**. Simultaneous-settlement opportunities (`Δt ≈ 0`) are unaffected and hold to settlement.

This eliminates the both-lose tail where it is economically justified, preserves upside optionality where exit is not justified, and avoids the certain-drag failure mode of unconditional exit. It degrades gracefully to an **alert** when the trading client is gated or unfunded (today's state), so decision support ships before execution.

## 3. Key Decisions

### 3.1 Policy: Conditional, Not Unconditional, Exit at t1

Decision: At t1, sell the surviving leg only when `lockValue − holdExpectedValue > exitCost + minMargin`, subject to a liquidity gate. Do not sell unconditionally.

Rationale:

- Unconditional exit is a blanket insurance purchase. Its premium has two parts: a **fixed** transaction cost (fees + spread, paid on every position) and a **variable** spread + risk-premium gap between the t1 bid and the expected t2 payoff. On the observed opportunity (~$0.10–0.20 edge, ~$13.75 size, ~$0.20 exit cost), the premium can be as large as the edge — insurance that costs as much as the event it insures is not worth buying.
- The surviving leg is most valuable **exactly in the losing branch** (early leg lost → the condition you bet against is now likely true → surviving leg worth ~0.90+). In the winning branch it is worth ~0.05 and selling it just pays a fee to forfeit a free option.
- A t1 quote read is a sufficient oracle: a high surviving-leg bid implies the early leg likely lost (sell → rescue), a bid near zero implies the early leg likely won (hold → keep optionality). No separate settlement monitor or win/loss resolver is required.

Consequences:

- The both-lose tail is cut precisely in the branch where the rescue is profitable; the winning-branch bonus tail is retained for free.
- Every opportunity with `Δt > 0` carries an explicit t1 exit recommendation rather than an implicit "hold."
- The policy is a per-situation decision, not a blanket rule, which is correct given the wide variation in edge, size, gap, and volatility across opportunity types.

### 3.2 Trigger: Timer at the Early Leg's Deadline, Not a Settlement Monitor

Decision: Register a timer at `earlyLeg.deadline` (a field already on every normalized opportunity). At t1, fetch the surviving leg's current book and evaluate the exit condition. Do not build a settlement-print reader or win/loss resolver.

Rationale:

- The surviving-leg market resolves the early outcome for free: its bid reflects the market's posterior over the early reference print. Reading one quote replaces a fragile, venue-specific settlement-monitor integration.
- `earlyLeg.deadline` is already produced by the normalizer's `parseDeadline`, so the trigger requires no new source data.
- A timer is trivially resumable via the existing Postgres-backed scan-state tables (ADR-0001 §3.8); a settlement monitor is not.

Consequences:

- t1 evaluation fires once per opportunity, near the early deadline. Accuracy of the deadline field directly gates trigger timing — deadline parsing bugs become exit-timing bugs.
- The trigger is independent of the scan loop (15-min cadence); a 14:00 deadline must fire at 14:00, not at the next 15-min tick.

### 3.3 Exit Gate: Two Thresholds (Exit-Cost and Liquidity)

Decision: Execute the t1 sell only when both gates pass:

- **Exit-cost gate:** `lockValue − holdExpectedValue > exitCost + minMargin`, where `exitCost = sellFee + estimatedSpread + estimatedSlippage` on the surviving leg.
- **Liquidity gate:** cap exit size at `haircut × survivingLegDepthAtT1`, because the surviving-leg book inverts at t1 and may be thin. Never dump the full position into an inverted book.

Rationale:

- A sell that locks less value than holding (net of cost) destroys EV for no risk reduction. The gate makes the insurance-purchase decision explicit and numeric.
- Thin inverted books turn a rescue into a scratch; the liquidity cap prevents a market-sell from sliding through a near-empty book.

Consequences:

- Some opportunities will be evaluated at t1 and correctly **held** (gate fails) — the alert records the decision and the reasoning so the operator can audit it.
- `minMargin` and the depth `haircut` become tunable risk parameters, surfaced in config rather than buried in code.

### 3.4 Scope: Only Sequential-Settlement Opportunities

Decision: Apply the conditional exit only to opportunities with `Δt > 0`. Simultaneous-settlement opportunities (macro Fed/CPI, sports match) hold to settlement — the t1 window does not exist.

Rationale:

- Same-reference, near-simultaneous settlement has negligible basis risk; there is no both-lose tail to cut and no surviving leg to exit. Acting adds cost and risk for no benefit.
- The policy therefore self-selects its scope from data already on the opportunity (`deadline` on each leg), requiring no manual per-type configuration.

Consequences:

- Crypto price-level (2h gap, different refs) → full active evaluation.
- Macro (minutes, same official release) and sports matches (minutes, same official result) → passive hold. The distinction falls out of `Δt` and `resolutionSource` automatically.

### 3.5 Rollout: Alert First, Execution Second

Decision: Ship the classifier, trigger registry, and t1 **alert with the recommended sell price/size and gate decision** before wiring any trading-client execution. Execution is added once the trading client is ungated and funded.

Rationale:

- The trading clients are currently gated (HITL) and unfunded (ADR-0001 §3.1). Building execution against a gated client is dead code.
- The decision support — "at t1, this opportunity's surviving leg should be sold at ≈$X up to N shares, gate passed/failed because …" — is independently valuable for operator review and for validating the model against live prints before it trades.
- This matches the project's established read-only-first discipline.

Consequences:

- Phase 1 is observable and safe: opportunities carry a `riskStructure` block and t1 alerts fire with recommendations, no orders placed.
- Phase 2 (execution) is a contained change behind the same gate interface, validated against the alert history.

### 3.6 Data: A `riskStructure` Block on Each Opportunity

Decision: Stamp each opportunity with a computed `riskStructure` containing: `earlyLeg`, `survivingLeg`, `dtHours`, `basisRiskClass` (`same_ref` | `diff_ref`), `payoffType`, `exitPolicy` (`evaluate` | `hold`), and at t1 the evaluated `lockValue`, `holdExpectedValue`, `exitCost`, `gateResult`, and `recommendedSellPrice`/`recommendedSellSize`.

Rationale:

- The inputs (`deadline`, `resolutionSource`, `payoffType`, `asset`) are already produced by the normalizer; the block is derived, not newly sourced.
- Persisting the evaluated decision makes the t1 reasoning auditable and backtestable, which the project's audit-trail discipline (ADR-0001 §3.7, §3.10) requires.

Consequences:

- A schema addition to the `opportunities` representation (JSONB block, no new relational table needed for phase 1).
- The block becomes the contract between the detector, the alerting path, and the future executor.

## 4. Rejected Alternatives

### 4.1 Unconditional Exit at t1

Rejected as the default policy. It eliminates the both-lose tail but pays the full premium (fixed transaction cost + spread + risk premium) on every position, including the winning branch where the surviving leg is near-worthless and selling only forfeits a free option for a fee. On the tight-edge, small-size crypto opportunities the scanner currently surfaces, the premium can equal or exceed the edge. It remains available as a config-selected policy (`exitPolicy: "always"`) for operators who want zero variance regardless of EV drag.

### 4.2 Hold to t2 (Status Quo)

Rejected as the default because it leaves the both-lose tail fully open for every sequential-settlement opportunity and records the divergence risk only as an advisory flag that is easy to overlook. Acceptable for same-reference simultaneous settlement, where this ADR already holds by default.

### 4.3 Settlement-Monitor-Driven Exit

Rejected as the t1 trigger mechanism. Reading and interpreting each venue's settlement print (CF Benchmarks at 14:00, Binance at 16:00) requires venue-specific integrations, handles print glitches and at-the-strike ambiguity, and duplicates work the surviving-leg market already does. The surviving-leg bid at t1 is a cheaper, more robust oracle for the early outcome. Reintroduce a settlement monitor only if quote liquidity at t1 proves insufficient to be a reliable signal.

### 4.4 Per-Opportunity-Type Hardcoding

Rejected. Hardcoding "crypto → sell, macro → hold" by topic duplicates information already present in `Δt` and `resolutionSource` and breaks when a new topic is added. The policy derives its scope from those fields instead.

## 5. Consequences and Tradeoffs

### Benefits

- The both-lose tail is cut where economically justified; upside optionality is retained where it is not.
- The t1 trigger uses a quote read, not a fragile settlement-monitor integration.
- Scope self-selects from existing normalized fields — no per-type configuration.
- Alert-first rollout delivers decision support now and a validated audit trail before any execution risk is taken.
- The `riskStructure` block makes the exit decision auditable and backtestable.

### Costs

- One extra schema field on opportunities and a small scheduler/registry for t1 triggers.
- Deadline-parsing accuracy now gates exit timing, not just pairing — existing deadline bugs become exit-timing bugs.
- Estimating `holdExpectedValue` and t1 liquidity requires modeling (volatility × gap × distance-from-strike); a poor estimate makes the gate wrong rather than safely conservative.
- Exit-cost and liquidity gates have tunable parameters (`minMargin`, depth `haircut`) that become operational knobs requiring documentation and sensible defaults.

### Risks

- Thin inverted books at t1 can make the rescue a scratch even when the gate passes; the liquidity haircut mitigates but cannot eliminate this.
- At-the-strike early prints produce an ambiguous surviving-leg bid; a confirmation threshold (not a single tick) is needed before acting.
- The policy reduces, not eliminates, risk — the surviving leg is sold into a market, and market/liquidity risk on the exit itself remains.

## 6. Open Questions

1. Volatility model for `holdExpectedValue` — historical realized vol of the index pair, or a simple proxy (gap length × distance-from-strike)? Decide before phase 1 ships the gate.
2. Default values for `minMargin` and the depth `haircut`, and whether they are per-asset or global.
3. Whether to record a t1 evaluation for opportunities where the gate fails (recommended: yes, for auditability) and how long to retain them.
4. Phase 2 execution: order type (market vs limit-at-bid), partial-fill handling, and the funding/HITL gate the executor sits behind.
