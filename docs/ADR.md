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
