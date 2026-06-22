# Production Next Steps

## Executive Summary

The project is code-complete and tested (202 unit + 39 integration tests passing). The safe production milestone is **not live trading** — it is a paper-only operating loop:

1. Run live public market and orderbook scans on crypto price-level / longer-window binary markets.
2. Persist every scan artifact, opportunity, paper-trade simulation, and review signal in Postgres.
3. Expose current opportunities and paper-trade simulations through the API and runbook.
4. Review enough observations to measure false positives, stale data, fill quality, and actionable edge.

This is an **observability + analytics** product, not a trading bot. Observe and Alert are MVP modes; Paper hedge is a near-term follow-up; Live-assisted is deferred.

### TL;DR — Fast Path to First Live Scan (~1–2 hours after VPS access)

The codebase is production-ready. The only real gap is operational:

1. **Provision the Hostinger VPS** (2 vCPU, 8GB RAM) and run `sudo bash scripts/deploy.sh` — it installs Docker, clones the repo, configures Nginx + SSL (certbot), and sets up the daily 2 AM backup cron.
2. **Configure `.env`** — at minimum set `DB_PASSWORD` (strong), `SENTRY_DSN`, and leave `LLM_ENABLED=false` for the first deterministic baseline.
3. **Run migrations:** `docker compose exec api npm run db:migrate`.
4. **Smoke-test venue connectivity** from the VPS: `curl 'https://external-api.kalshi.com/trade-api/v2/markets?status=open&limit=1'` and `curl 'https://gamma-api.polymarket.com/markets?limit=1'`.
5. **Start the stack:** `docker compose up -d --build`. The worker auto-runs a scan on boot, then every `WORKER_SCAN_INTERVAL_MINUTES` (default 15).
6. **Watch the first scan:** `docker compose logs -f worker`, then verify rows in `scan_runs`, `scan_steps`, `venue_market_snapshots`, `opportunities`, and `paper_trade_simulations`.
7. **Monitoring:** Uptime Robot → `/health` (requires Nginx in front, since the API is bound to `127.0.0.1:3000`); Sentry alerts for error rate.

Everything else is code-complete and tested. The rigorous milestones below are the full version of this fast path, with pass/fail gates.

## What Was Fixed in This Pass

- **Paper-trade persistence is now production-wired.** `ScannerModule` previously constructed `ReadOnlyScanner` without injecting `PaperTradeSimulator`, so live scans emitted zero `paper_trade_simulations` rows and `/v1/opportunities/:id/paper-trades` was always empty despite opportunities being detected. The simulator is now injected (default target notionals `[5, 25, 100, executableSizeUsd]`, 25 bps adverse selection), with a regression assertion in the worker e2e smoke test. This closes the P0 below.

## Evidence Reviewed

- `docs/Handoff0618.md`: Phase 6 CI/CD gates exist, including typecheck, build, coverage, integration tests, migration tests, acceptance tests, and a quality gate.
- `docs/Handoff0603.md`: early production blockers were identified, then later entries mark real orderbook clients, orderbook snapshot persistence, LLM scanner integration, risk modeling, resumable worker, Sentry check-ins, and API readiness as completed. The remaining explicit launch gates include production analytics, Sentry configuration, false-positive measurement, and a meaningful paper-trading sample.
- `docs/PROJECT-SCOPE.md`: MVP scope is cross-venue arbitrage on Kalshi and Polymarket, focused first on crypto price levels and longer-window crypto binaries, with macro events after crypto stability. IBKR remains out of scope.
- `docs/PRD.md`: the MVP is a read-only, observable, Postgres-backed arbitrage intelligence scanner. It is not an autonomous trading bot. Observe and Alert are MVP modes; Paper hedge is a near-term follow-up; Live-assisted is deferred.
- `docs/PHASE7-DEPLOYMENT.md`: target production deployment is a VPS with Docker Compose, Postgres, API, worker, Nginx/HTTPS, Sentry, backups, and SLO monitoring.
- `package.json`: required verification commands include `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:integration`, `npm run test:acceptance`, `npm run coverage`, `npm run db:migrate`, and `npm run smoke:sentry-monitor`.
- `CLAUDE.md` and `AGENTS.md`: GitNexus is the required code-intelligence surface before symbol edits and before commits.
- Source inspection: `src/main-worker.ts`, `src/contexts/scanner/worker-scan-runner.ts`, `src/contexts/scanner/scanner.module.ts`, `src/contexts/scanner/read-only-scanner.ts`, `src/contexts/venues/infrastructure/http-venue-clients.ts`, `src/contexts/scanner/postgres-scanner-repository.ts`, `src/contexts/arbitrage/domain/paper-trade-simulator.ts`, API controllers/read models, `docker-compose.yml`, `.env.example`, and `runbook/paper-trade-runbook.ts`.

## Current State

### Production Scanning Surface

The production worker exists and runs a loop via `npm run start:prod:worker`. Each iteration marks abandoned scans, executes a resumable scan, and waits for `WORKER_SCAN_INTERVAL_MINUTES` before the next scan. Docker Compose wires the worker, API, and Postgres with health checks and production environment variables. The worker auto-runs a scan on boot, then every interval.

The public venue clients now fetch:

- Kalshi open markets and per-market orderbooks from `https://external-api.kalshi.com/trade-api/v2`. No API key required for public endpoints.
- Polymarket markets from Gamma and orderbooks from CLOB token books. No API key required.

`ReadOnlyScanner` fetches both venues, normalizes markets, reviews ambiguous matches, creates candidate pairs, calculates opportunities, simulates paper trades, reports telemetry, and saves completed scan artifacts. `PostgresScannerRepository.saveCompletedScan` persists venue snapshots, normalized markets, candidate pairs, orderbook snapshots, opportunities, scan runs, and paper-trade simulations supplied by the scanner.

### API and Operator Visibility

The API exposes the core read model:

- `GET /health`
- `GET /v1/opportunities`
- `GET /v1/opportunities/:id`
- `GET /v1/opportunities/:id/paper-trades`
- `GET /v1/scan-runs/latest`
- `GET /v1/markets`

Opportunity listing supports filters for equivalence class, minimum net edge, maximum staleness, risk flags, human-review state, and sorting by detected time, net edge, opportunity age, or equivalence class.

**Note:** there is no scan-trigger endpoint, by design. The only way to start a scan is to start (or restart) the worker; the API strictly reads from Postgres and never mutates venue state. See Safety Boundaries.

### Paper Trading Surface

The deterministic `PaperTradeSimulator` is now wired into production scans. It simulates target notionals of `[5, 25, 100, executableSizeUsd]` by default, applies 25 bps adverse selection by default, walks both legs' depth, and records partial fill, residual exposure, fees, slippage, gross edge, and net edge. Rows are persisted to `paper_trade_simulations` for every emitted opportunity.

There is also a Postgres-backed paper-trade read path and CLI runbook:

```bash
export DATABASE_URL=postgres://...
npx ts-node runbook/paper-trade-runbook.ts <opportunity-id> [target-notional,...]
```

## Launch Blockers

### P0: Prove Live Public Scans Produce Real Traceable Opportunities

The highest launch risk is not whether the code compiles; it is whether production live scans produce usable Class A opportunities from real Kalshi and Polymarket data. The handoff history says the original empty-orderbook blockers were fixed, but the remaining gate is empirical production evidence.

Required proof:

- At least 7 consecutive days of scheduled worker runs in paper-only mode.
- Each successful scan records nonzero `marketsScanned`.
- Orderbook snapshots are persisted for both venues when market data is available.
- Every emitted opportunity has `kalshiOrderbookSnapshotId` and `polymarketOrderbookSnapshotId`.
- Every emitted opportunity has bounded `dataStalenessMs`, current `lastVerifiedAt`, and risk fields.
- Every emitted opportunity has persisted `paper_trade_simulations` rows (now wired — verify they appear).
- No scan path can place orders or call authenticated trading mutation endpoints.

### ~~P0: Paper-Trade Persistence Is Not Production-Wired~~ (RESOLVED)

Previously: production scanner construction did not inject `PaperTradeSimulator`, so the worker could detect opportunities while `/v1/opportunities/:id/paper-trades` remained empty. **Fixed** — `ScannerModule` now injects the simulator; see "What Was Fixed in This Pass" above. Remaining proof:

- Production scans produce persisted rows in `paper_trade_simulations` for each emitted opportunity.
- The API endpoint returns those rows for real opportunity IDs.
- The runbook renders the same rows for target notionals `5,25,100`.

### P1: Sentry and Operational Monitoring Need Real Production Confirmation

The code supports Sentry scan check-ins, venue fetch telemetry, scan metrics, stale data telemetry, and opportunity telemetry. Docker Compose passes Sentry configuration. The remaining launch gate is configuration and proof in the production Sentry project.

Required proof:

- `SENTRY_DSN` and `SENTRY_MONITOR_SLUG` are set in production.
- `npm run smoke:sentry-monitor` creates an in-progress/ok monitor pair in Sentry.
- Worker failures appear with sanitized `failureCategory` / `failureReason` and no secrets.
- Scan success rate, scan latency, and error rate can be reviewed daily.
- Uptime Robot (or equivalent) pings `/health`. Note: `/health` is bound to `127.0.0.1:3000` inside Docker, so external uptime monitoring requires the Nginx proxy from `deploy.sh`.

### P1: False-Positive and Fill-Quality Metrics Are Missing

The system can label equivalence classes and calculate opportunity edges, but production readiness depends on measured performance over real observations.

Required proof:

- Class A false-positive rate is measured by manual review.
- Paper-trade actionable edge is compared against opportunity-level apparent edge.
- Partial-fill rate and residual exposure are tracked.
- Edge leakage from fees, slippage, and adverse selection is summarized.

### P2: Deployment Runbook Needs an Operator Checklist

`docs/PHASE7-DEPLOYMENT.md` and `scripts/deploy.sh` cover deployment mechanics, but the production launch still needs a daily operating checklist for this specific scanner: health checks, latest scan status, opportunity sampling, paper-trade review, and incident response.

## Minimum Safe Path to Production Read-Only Analytics

### Milestone 1: Local Production Gate

Purpose: prove the repo is locally healthy before deployment.

Run:

```bash
npm run typecheck
npm run build
npm run test
npm run test:integration
npm run test:acceptance
npm run coverage
```

Pass criteria:

- Every command exits 0.
- Coverage remains above configured thresholds.
- Integration tests can create/drop disposable Postgres databases or use `TEST_DATABASE_URL`.
- Acceptance tests verify API contracts against seeded data.

Stop if:

- Any existing test fails. Do not edit tests to make the gate pass.
- Docker/Postgres is unavailable for integration or acceptance tests; document the missing dependency.

### Milestone 2: Deploy Read-Only Stack

Purpose: deploy the API, worker, and Postgres without enabling any live trading capability.

Run on the VPS after setting production `.env` values:

```bash
sudo bash scripts/deploy.sh        # installs Docker, Nginx + SSL, backup cron
docker compose up -d --build
docker compose exec api npm run db:migrate
docker compose ps
curl http://localhost:3000/health
curl http://localhost:3000/v1/scan-runs/latest
```

Required environment (in `.env`, consumed by `docker-compose.yml`):

- `DB_PASSWORD` — must be a strong value (required; no default).
- `DATABASE_URL` — auto-assembled by Docker Compose for API and worker.
- `DB_USER` (default `arbitrage_user`) and `DB_NAME` (default `arbitrage`) — confirm these defaults before `docker compose up`.
- `API_PORT` (default 3000).
- `WORKER_SCAN_INTERVAL_MINUTES=15` is acceptable for the first production run.
- `SENTRY_DSN` and `SENTRY_MONITOR_SLUG` should be set before claiming production observability.
- `LLM_ENABLED=false` is acceptable for the first deterministic baseline; enable LLM only after deterministic scans are stable and cost/latency are monitored.

LLM-specific notes (only relevant once you flip `LLM_ENABLED=true`):

- `LLM_BASE_URL` defaults to `http://host.docker.internal:11434/api/chat`. On **Linux Docker**, `host.docker.internal` does not resolve unless `extra_hosts: ["host.docker.internal:host-gateway"]` is added (or use the VPS host IP). Verify reachability before relying on it.
- `LLM_MODEL` defaults to `minimax-m3:cloud`. The model your Ollama instance actually serves must match, or LLM calls will 404 once enabled. With `LLM_ENABLED=false` this is moot — the scanner runs deterministic-only matching (no equivalence promotion).

Pass criteria:

- `docker compose ps` shows healthy Postgres and API, and a running worker.
- `/health` returns success through localhost or Nginx.
- `/v1/scan-runs/latest` shows a recent scan, not the fallback `none` response.
- Worker logs show completed scan iterations without tight-looping.

Stop if:

- The worker calls or requires authenticated trading credentials.
- Required secrets are missing. Record the missing variable; do not invent values.
- Scan failures include sensitive data in logs or API responses.

### Milestone 3: First Real Opportunity Scan Window

Purpose: collect production evidence without trading.

Run these checks after at least one worker interval:

```bash
curl 'http://localhost:3000/v1/scan-runs/latest'
curl 'http://localhost:3000/v1/markets?limit=20'
curl 'http://localhost:3000/v1/opportunities?equivalenceClass=A&minNetEdge=0.01&maxDataStalenessMs=10000&limit=20'
```

Review in Postgres if API data is ambiguous:

```sql
select status, started_at, completed_at, metrics
from scan_runs
order by started_at desc
limit 10;

select count(*) from venue_market_snapshots;
select count(*) from orderbook_snapshots;
select count(*) from normalized_markets;
select count(*) from candidate_pairs;
select count(*) from opportunities;
select count(*) from paper_trade_simulations;
```

Pass criteria:

- Successful scans have nonzero market counts.
- Real venue snapshots and orderbook snapshots accumulate.
- Opportunities, if present, are Class A or explicitly human-review gated.
- No opportunity lacks source snapshot IDs.
- Each opportunity has corresponding `paper_trade_simulations` rows.
- Stale/empty books do not produce approved opportunities.

Stop if:

- Scans succeed with zero markets for both venues.
- Opportunities appear without orderbook snapshot provenance.
- API requests trigger scans instead of reading Postgres.

## Paper-Trading Validation Milestone

Purpose: prove detected opportunities survive realistic fill and cost assumptions before any live-assisted work is considered.

### Required Target Notionals

Use the simulator defaults first:

- `$5`: matches current Kalshi starting-capital constraints and verifies small-account usability.
- `$25`: medium manual review size.
- `$100`: stress target for liquidity and partial-fill behavior.
- `executableSizeUsd`: actual scanner-estimated executable size.

### Expected Persisted Outputs

For each opportunity selected for review, `paper_trade_simulations` should include:

- `target_notional_usd`
- long-leg and hedge-leg average prices, contracts, fees, and slippage
- `adverse_selection_bps`
- `partial_fill`
- `residual_exposure_usd`
- combined cost, gross edge, and net edge
- calculation and config versions

### Operator Checks

Run:

```bash
curl 'http://localhost:3000/v1/opportunities?equivalenceClass=A&minNetEdge=0.01&limit=5'
curl 'http://localhost:3000/v1/opportunities/<opportunity-id>/paper-trades'
export DATABASE_URL=postgres://...
npx ts-node runbook/paper-trade-runbook.ts <opportunity-id> 5,25,100
```

### Review Metrics

Track at least these metrics for the first sample:

- Count of reviewed opportunities.
- Class A false positives after manual resolution-text review.
- Opportunity net edge versus paper-trade net edge.
- Worst edge leakage in basis points.
- Partial-fill rate.
- Residual exposure distribution.
- Median and p95 data staleness.
- Time between `firstDetectedAt` and `lastVerifiedAt`.

### Initial Sample Size

Minimum sample before any live-assisted design work:

- At least 30 days of read-only analytics, or
- At least 50 reviewed Class A opportunity observations, whichever comes later.

Pass criteria:

- Class A manual false-positive rate is below 5%.
- At least 80% of reviewed opportunities remain actionable at `$5` notional after paper-trade costs.
- Median actionable net edge remains positive after 25 bps adverse selection.
- No opportunity is approved when either leg is stale, unfillable, or missing provenance.

Fail criteria:

- Paper-trade rows are missing for emitted opportunities.
- Paper-trade net edge is usually negative despite positive opportunity net edge.
- Partial fills or residual exposure dominate the `$5` target.
- Manual review finds recurring resolution mismatch between venues.

## Ranked Next Steps

### P0: Run the Local Gate and Deploy Read-Only Stack

Owner outcome: a healthy VPS deployment that only observes, persists, scores, and serves data.

Commands:

```bash
npm run typecheck
npm run build
npm run test
npm run test:integration
npm run test:acceptance
docker compose up -d --build
docker compose exec api npm run db:migrate
curl http://localhost:3000/health
```

### P0: Prove Real Scan Artifacts Accumulate

Owner outcome: the worker proves it can ingest public venue data and produce traceable scan artifacts.

Checks:

```bash
curl http://localhost:3000/v1/scan-runs/latest
curl 'http://localhost:3000/v1/markets?limit=20'
curl 'http://localhost:3000/v1/opportunities?limit=20'
```

If no opportunities appear, that is acceptable at first; inspect market counts, orderbook counts, and candidate-pair counts before assuming failure. The first target is healthy scan evidence, not forced opportunities.

### P0: Verify Production Paper Simulations

Owner outcome: every emitted opportunity has deterministic paper-trade records visible through API and runbook.

Checks:

```bash
curl 'http://localhost:3000/v1/opportunities/<opportunity-id>/paper-trades'
export DATABASE_URL=postgres://...
npx ts-node runbook/paper-trade-runbook.ts <opportunity-id> 5,25,100
```

### P1: Turn On Sentry Production Monitoring

Owner outcome: scan health, scan failures, stale data, and opportunity telemetry are visible outside logs.

Commands:

```bash
npm run smoke:sentry-monitor
docker compose logs -f worker
```

Required confirmation:

- Monitor slug receives `in_progress` and `ok` check-ins.
- Failed scans report sanitized failure categories.
- No secrets appear in Sentry events or scan-run metrics.

### P1: Start Manual Review Log

Owner outcome: production analytics becomes measurable instead of anecdotal.

Track each reviewed opportunity with:

- opportunity ID
- venue market IDs
- equivalence class
- net edge
- data staleness
- paper-trade net edge at `$5`, `$25`, `$100`
- manual resolution-wording verdict
- final operator decision: ignore, watch, paper-valid, or false positive

### P2: Add Operator Runbook

Owner outcome: daily operations are repeatable.

The runbook should cover:

- checking container health
- checking latest scan status
- sampling opportunities
- running paper-trade dashboard
- reviewing Sentry monitor status
- restoring database backups
- pausing the worker without losing API read access

## Safety Boundaries

- No live autonomous trading.
- No order placement adapters in the production path.
- No wallet signing, private keys, seed phrases, or execution credentials in production env.
- No API endpoint should trigger a venue scan or mutation; API reads from Postgres. The only scan trigger is starting the worker.
- LLMs may assist interpretation but must not be final trade/no-trade authority.
- Human review remains required before any later live-assisted workflow.

## Verification Gates Before Production Launch Claim

These commands must pass before claiming the project is production-ready for read-only analytics:

```bash
npm run typecheck
npm run build
npm run test
npm run test:integration
npm run test:acceptance
npm run coverage
```

Operational gates:

- Docker Compose stack starts cleanly.
- Migrations apply with `npm run db:migrate` inside the API container.
- `/health` succeeds.
- `/v1/scan-runs/latest` returns a real latest scan.
- Worker completes scheduled scans for at least 7 days without recurring failures.
- Sentry monitor receives check-ins when configured.
- Backups are configured and one restore procedure is rehearsed on a non-production database.

Analytics gates:

- Public venue scans produce persisted markets and orderbooks.
- Candidate-pair and opportunity counts are explainable.
- Opportunities are traceable to source snapshots.
- Class A false-positive rate is measured.
- Paper-trade simulations are persisted and queryable for every emitted opportunity.

## Optional Enhancements

These are useful but should not block the first read-only production analytics run:

- P2: Operator runbook expansion and immutable opportunity observation history.
- P3: Private dashboard UI.
- P3: Macro event expansion after crypto scanning is stable.
- P3: More sophisticated secret management than `.env` on a locked-down VPS.
- P4: Cloud-managed Postgres or ECS/Fargate deployment.
- P4: Paid public API.
- P4: Live-assisted execution architecture after paper-trading evidence is strong and reviewed by a human.

## Recommended Next 3 Operator Actions

1. Run the local verification gate and fix only true production blockers: `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:integration`, and `npm run test:acceptance`.
2. Deploy the Docker Compose stack in read-only mode with Sentry configured, then observe `/v1/scan-runs/latest`, `/v1/markets`, and `/v1/opportunities` for the first 24 hours.
3. Verify `/v1/opportunities/:id/paper-trades` returns rows for real opportunities and that the runbook renders the same rows at `5,25,100`.