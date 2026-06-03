# Product Requirements Document: Cross-Venue Prediction Market Arbitrage Intelligence

## 1. Summary

Build a read-only, observable, Postgres-backed arbitrage intelligence system for identifying cross-venue prediction-market opportunities between Kalshi and Polymarket. The MVP focuses on crypto price-level / longer-window binary markets first, then scheduled macroeconomic events such as Fed decisions and CPI. The system uses deterministic pricing/risk logic plus stateless LLM-assisted market interpretation to identify potentially equivalent markets, estimate fee-adjusted edge, and produce explainable opportunities for human review.

The initial product is **not** an autonomous trading bot. It is an **arb intelligence scanner** designed to evolve later into a private dashboard, public API, and paid customer-facing service.

## 2. Background and Rationale

The project previously explored Polymarket crypto latency arbitrage. Review showed that short-window latency arbitrage is crowded, infrastructure-heavy, and easy to overfit in paper trading. The better risk-adjusted opportunity is cross-venue arbitrage: find the same or near-identical event on multiple venues, buy the underpriced side on one venue, and hedge with the opposite side on another.

This approach avoids relying primarily on directional prediction. Instead, it exploits fragmentation, venue-specific liquidity, fee differences, slow price synchronization, and capital constraints.

## 3. Goals

### 3.1 MVP Goals

1. Fetch public market and orderbook data from Kalshi and Polymarket.
2. Normalize crypto price-level markets into structured domain objects.
3. Generate candidate cross-venue market pairs.
4. Use LLM-assisted normalization and equivalence critique for ambiguous market wording.
5. Deterministically approve, reject, or flag candidate pairs based on structured fields and risk rules.
6. Calculate gross and estimated net arbitrage edge after fees, slippage, and fill assumptions.
7. Persist market snapshots, normalized markets, LLM evaluations, candidate pairs, opportunities, and scan runs in Postgres.
8. Provide terminal/JSON output and a minimal internal API for latest opportunities.
9. Add Sentry-backed observability for scanner failures, LLM cost/latency/token usage, and job health.
10. Keep all trading decisions manual in MVP.

### 3.2 Future Goals

1. Add macro event matching for Fed, CPI, jobs, and inflation markets.
2. Add private web dashboard.
3. Add public API suitable for paid customers.
4. Add customer accounts, API keys, tiers, rate limits, and billing.
5. Add live-assisted trade execution only after scanner accuracy and fill assumptions are validated.
6. Evaluate Temporal or a stronger workflow engine if scan orchestration becomes long-running, distributed, or customer-critical.

## 4. Non-Goals

1. No fully autonomous live trading in MVP.
2. No IBKR integration in MVP.
3. No 15-minute crypto latency-arbitrage hot path.
4. No sports, politics, weather, or entertainment markets in MVP.
5. No public paid API in the first implementation phase.
6. No full event-sourcing platform or Kafka in MVP.
7. No Temporal in MVP unless simple DB-backed orchestration proves insufficient.
8. No LLM in final trade/no-trade execution authority.

## 5. Target Users

### 5.1 Initial User

The project owner/operator, who wants a reliable scanner for learning and manually reviewing cross-venue opportunities.

### 5.2 Future Users

1. Prediction-market traders looking for cross-venue mispricing alerts.
2. Researchers tracking market fragmentation.
3. Paid API/dashboard customers who want structured opportunity feeds.

## 6. Scope

### 6.1 Venues

MVP venues:

- Kalshi: account exists with approximately $50 starting capital.
- Polymarket: account registered.

Deferred:

- IBKR: account exists but API complexity and instrument mismatch make it out of scope.

### 6.2 Topics

MVP topic order:

1. Crypto price-level and longer-window binary markets.
   - BTC above/below threshold.
   - ETH above/below threshold.
   - Daily/weekly/monthly/year-end milestone markets.
2. Macro/economic releases after crypto pipeline is stable.
   - Fed rate decisions.
   - CPI ranges/thresholds.
   - Jobs report / unemployment / payroll markets.

### 6.3 Product Modes

1. Observe: fetch and store data only.
2. Alert: emit explainable opportunity alerts.
3. Paper hedge: simulate both legs with top-of-book/slippage assumptions.
4. Live-assisted: future mode requiring explicit human confirmation.

MVP includes Observe and Alert. Paper hedge is a near-term follow-up. Live-assisted is deferred.

## 7. Functional Requirements

### 7.1 Venue Market Ingestion

The system must:

1. Fetch Kalshi market/event/orderbook data using official REST/WebSocket APIs as needed.
2. Fetch Polymarket markets primarily via Gamma API and orderbooks via CLOB endpoints.
3. Store raw venue payloads as JSONB for audit and future parser improvements.
4. Handle API rate limits, timeouts, and retries.
5. Mark stale data and avoid using stale books for opportunity calculation.

### 7.2 Market Normalization

The system must normalize venue markets into a common representation including venue, venue market ID, title/question, raw resolution text, topic, event type, asset/entity, threshold, operator, deadline/timezone, payoff type, resolution source, ambiguity flags, and confidence score.

### 7.3 Candidate Pair Generation

The system must deterministically generate candidate pairs using cheap filters before LLM calls: same broad topic, same asset/entity, similar deadline, compatible threshold, and compatible event type.

The system must not compare all markets against all markets without filtering.

### 7.4 LLM-Assisted Matching

The system must use LLMs as stateless structured workers for market normalization, equivalence comparison, adversarial critique, and human-readable explanations.

The system must persist every LLM input/output, parsed response, prompt version, model, token usage, cost estimate, and status.

LLMs must not be the final authority for trading. Deterministic policy decides whether a pair is tradable, alert-only, rejected, or needs human approval.

### 7.5 Equivalence Classification

Candidate pairs must be classified as:

- A: same event, same source or compatible source, same threshold/operator, same deadline/payoff semantics; eligible for alerts and later paper/live workflows.
- B: similar economic event but wording/source/timing differences; alert-only or human review.
- C: related topic but materially different payoff condition; reject.
- D: unclear; reject or human review.

Automatic opportunity alerts must require equivalence class A or explicit human-approved templates.

### 7.6 Opportunity Calculation

The system must calculate both directions: Kalshi YES + Polymarket NO, and Polymarket YES + Kalshi NO.

For each candidate, calculate combined cost, gross edge, fee estimate, slippage estimate, top-of-book liquidity, max tradable notional, net edge, fill risk, resolution risk, data staleness, and opportunity age.

### 7.7 Persistence

The system must persist scan runs, venue market snapshots, normalized markets, candidate pairs, LLM evaluations, orderbook snapshots, opportunities, and emitted alerts.

### 7.8 API

MVP internal API endpoints:

- `GET /health`
- `GET /v1/opportunities`
- `GET /v1/opportunities/:id`
- `GET /v1/scan-runs/latest`
- `GET /v1/markets`

The API should read from Postgres and must not trigger live venue scans on request.

### 7.9 Observability

The system must include structured logs, Sentry error tracking, Sentry cron/check-in monitoring for scan jobs, Sentry LLM spans/metrics, and DB-persisted scan metrics.

Full prompts/outputs are stored in Postgres. Sentry receives metadata by default and redacted/sampled prompt context only under configured policies.

## 8. Non-Functional Requirements

### 8.1 Reliability

- Scanner jobs must be resumable from persisted state.
- Re-running a scan step must be idempotent where practical.
- Failed LLM evaluations must be retryable.
- API must continue serving latest persisted opportunities if scanner is down.

### 8.2 Security

- Never log API keys, private keys, account secrets, wallet private keys, auth headers, or customer PII.
- Redact sensitive fields before sending data to Sentry.
- Store secrets in environment variables or future secret manager.
- Do not expose raw venue data publicly until venue terms are reviewed.

### 8.3 Scalability

- MVP targets single worker + API process.
- Architecture should allow later horizontal scaling of workers and API.
- Scanner writes to Postgres; API reads from Postgres.
- No public API request should perform expensive LLM or venue scans synchronously.

### 8.4 Maintainability

- Use DDD-inspired modular monolith.
- Use dependency injection for readability and testability.
- Keep domain logic pure and independent of HTTP, DB, Sentry, and LLM SDKs.
- Use database migrations for every schema change.

### 8.5 Cost Control

- Avoid unbounded LLM fan-out.
- Cache LLM evaluations by input hash, prompt version, and model.
- Track token/cost metrics per scan and per task.
- Use cheap deterministic filters before LLM calls.

## 9. Architecture Overview

The system is a NestJS modular monolith with separate API and worker runtimes.

```text
Venue APIs -> Worker Scanner -> Postgres <- API <- Future Dashboard/Public API
                    |
                    v
              LLM Gateway
                    |
                    v
                 Sentry
```

Runtime roles: `api`, `worker`, `postgres`, `migrate`, future `web`, and optional future `redis`.

## 10. Technical Stack

- Language: TypeScript
- Framework: NestJS
- Architecture: DDD-inspired modular monolith with dependency injection
- Database: Postgres
- DB layer: Drizzle
- Migrations: Drizzle migrations
- Local orchestration: Docker Compose
- MVP hosted DB: Neon Postgres preferred
- Later production DB: AWS RDS Postgres if AWS becomes standard
- Observability: Sentry + structured logs
- LLM integration: centralized LLM gateway with persisted evaluations
- Job orchestration: Postgres-backed resumable jobs initially
- Workflow engine: Temporal deferred until needed

## 11. Domain Model Sketch

### 11.1 NormalizedMarket

```ts
interface NormalizedMarket {
  id: string;
  venue: "kalshi" | "polymarket";
  venueMarketId: string;
  topic: "crypto" | "macro";
  eventType: "price_above" | "price_below" | "fed_rate_decision" | "cpi_range";
  asset?: "BTC" | "ETH";
  threshold?: number;
  operator?: ">" | ">=" | "<" | "<=" | "=" | "between";
  deadline?: string;
  timezone?: string;
  resolutionSource?: string;
  payoffType: "at_time" | "any_time_before" | "range" | "settlement_value";
  ambiguityFlags: string[];
  confidence: number;
}
```

### 11.2 CrossVenueOpportunity

```ts
interface CrossVenueOpportunity {
  id: string;
  pairId: string;
  longLeg: ContractLeg;
  hedgeLeg: ContractLeg;
  combinedCost: number;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  netEdge: number;
  maxTradableUsd: number;
  equivalenceClass: "A" | "B" | "C" | "D";
  resolutionRisk: "low" | "medium" | "high";
  fillRisk: "low" | "medium" | "high";
  detectedAt: string;
  lastVerifiedAt: string;
}
```

## 12. Suggested Modules

```text
src/
  app.module.ts
  main-api.ts
  main-worker.ts
  contexts/
    venues/
    matching/
    arbitrage/
    scanner/
    llm/
    observability/
    api/
  db/
```

## 13. Data Model Requirements

Initial tables should include `scan_runs`, `venue_market_snapshots`, `normalized_markets`, `candidate_pairs`, `llm_evaluations`, `orderbook_snapshots`, `opportunities`, and `alerts`.

Use JSONB for raw venue payloads and LLM input/output. Add normalized columns for queryable fields.

## 14. LLM Policy

1. LLM calls must be small and stateless.
2. No giant long-running conversation memory.
3. Every input/output must be persisted.
4. Each prompt must have a version.
5. LLM results must be schema validated.
6. Failed schema validation must be observable and retryable.
7. Deterministic rules make final opportunity approval decisions.
8. Prompt/output data sent to Sentry must be redacted and sampled according to config.

## 15. Deployment and Local Development

Local Docker Compose services: postgres, migrate, api, and worker.

Local DB may run in Docker for reproducibility and easy reset. Cloud MVP uses Neon Postgres. Later AWS production may use RDS.

## 16. Success Metrics

### 16.1 MVP Technical Success

- Scanner can run repeatedly without manual intervention.
- Market snapshots and scan runs persist correctly.
- Candidate pairs are explainable.
- LLM evaluations are cached and observable.
- API serves latest opportunities from DB.
- Sentry reports failed scans/LLM errors.

### 16.2 MVP Product Success

- Finds real candidate cross-venue opportunities.
- Correctly rejects non-equivalent markets.
- Produces opportunity explanations useful for human review.
- Demonstrates whether opportunities survive fees/slippage/resolution risk.

### 16.3 Not an MVP Success Criterion

Meaningful profit is not required with the starting $50 bankroll. The first milestone is validated intelligence, not trading PnL.

## 17. Phased Plan

1. Documentation and skeleton.
2. Read-only crypto scanner.
3. LLM matching pipeline.
4. Opportunity calculator.
5. Internal API.
6. Macro expansion.
7. Dashboard/public API preparation.
8. Live-assisted trading evaluation.

## 18. Open Questions

1. Which LLM provider/model should be primary for market matching?
2. Should macro markets be added before or after paper hedge simulation?
3. What minimum net edge should trigger an alert for a $50 bankroll?
4. What prompt/output retention period should be used in production?
5. What customer-facing data can legally be redistributed under venue terms?
