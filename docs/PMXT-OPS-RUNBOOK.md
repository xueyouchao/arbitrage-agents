# PMXT Shadow Operations Runbook

> **Issue:** #100
> **Applies to:** PMXT Hosted shadow-evaluation pipeline (issues #93, #95, #97, and downstream)
> **Companion document:** `docs/PMXT-MIGRATION-PLAN.md`

This runbook covers gated enablement, secret injection and rotation, worker health, request/cost/retention monitoring, pause/lease drain, rollback, terms changes, data purge, and final teardown for the PMXT shadow evaluation.

---

## Critical rule: environment variable changes require restart or redeploy

**Disabling an environment variable does not take effect without a process restart or redeploy.** The PMXT shadow configuration is read at process startup by `loadAppConfig` (see `src/config/app-config.ts`). The `PmxtShadowRunner` provider in `ScannerModule` decides at NestJS bootstrap time whether to instantiate the runner or return `undefined`. Once the process is running, changing `PMXT_SHADOW_ENABLED=false` in the environment has no effect until the worker process is restarted or the container is redeployed.

Every procedure in this runbook that says "set `PMXT_SHADOW_ENABLED=false`" must be followed by a restart or redeploy of the shadow worker process for the change to take effect.

---

## 1. Enablement checklist

Before starting the PMXT shadow worker for the first time, complete every item below. Do not skip any step. If any step fails, stop and remediate before proceeding.

### 1.1 Authorization issue acceptance

- [ ] Confirm the project owner's Free-tier terms acceptance is recorded (see PMXT-MIGRATION-PLAN.md §12.1).
- [ ] Confirm the authorization issue (GitHub issue that approved the evaluation) is closed and referenced in deployment notes.
- [ ] Confirm the internal read-only operating boundary is documented: no execution, no account access, no commercial resale, no competitive product, no public benchmark, no reverse engineering, no database reconstruction.

### 1.2 Validated hosted config

- [ ] `PMXT_API_KEY` is set to a valid hosted read-only key. Verify it is not a trading or account-scoped key.
- [ ] `PMXT_HOSTED_BASE_URL` is set to the correct hosted endpoint (e.g., `https://api.pmxt.dev`). The URL must not contain credentials.
- [ ] `PMXT_SHADOW_ENABLED=true` is set.
- [ ] At least one of `PMXT_SHADOW_READS_ENABLED=true` or `PMXT_SHADOW_ROUTER_ENABLED=true` is set. Both can be enabled independently.
- [ ] `PMXT_SHADOW_SAMPLE_RATE` is set to a low deterministic sample rate (see §1.5 below).
- [ ] `PMXT_SHADOW_MAX_QUEUE_DEPTH` is set (hard bound on pending requests).
- [ ] `PMXT_SHADOW_MAX_QUEUE_WAIT_MS` is set (maximum queue wait before skip/timeout).
- [ ] `PMXT_SHADOW_MAX_REQUESTS_PER_RUN` is set (hard cap on API requests per run).
- [ ] `PMXT_SHADOW_MAX_MONTHLY_CREDITS` is set (approved monthly credit ceiling).
- [ ] `PMXT_SHADOW_MAX_MONTHLY_COST_USD` is set (approved monthly cost ceiling).
- [ ] `PMXT_SHADOW_RAW_RETENTION_DAYS` is set only if raw-payload persistence has been explicitly approved. When unset or `0`, raw payloads are not persisted.

### 1.3 Migrations

- [ ] Migration `0013_pmxt_shadow_run_attempts.sql` has been applied to the target database.
- [ ] Verify the `pmxt_shadow_run_attempts` table exists with the expected schema and indexes:
  ```sql
  SELECT count(*) FROM pmxt_shadow_run_attempts;
  -- Should return 0 on a fresh migration.
  ```
- [ ] Confirm the foreign key to `scan_runs(id)` with `ON DELETE CASCADE` is in place, so deleting an authoritative scan run cascades to its shadow attempts.

### 1.4 Monitoring

- [ ] Shadow Sentry monitoring is configured with a distinct slug and tags (see §6 below).
- [ ] Alerts for authentication failure, sustained rate limiting, shadow-runner timeout, mapping-failure spike, outcome-orientation conflict, and unexpected cost/request-volume increase are configured.
- [ ] Confirm no PMXT-derived alert can trigger a trading or opportunity alert.

### 1.5 Low deterministic sample rate

- [ ] Start with a low deterministic sample rate. The sample rate is expressed as an exact rational `numerator/denominator` (e.g., `1/20` for 5% of authoritative scans).
- [ ] The sample rate must be positive but low. A recommended starting point is `1/20` (5%) or `1/10` (10%).
- [ ] The sample rate is deterministic: the same scan run ID and config fingerprint always produce the same inclusion decision (see `isScanIncludedInSample` in `src/contexts/scanner/pmxt/pmxt-shadow-runner.ts`).
- [ ] Record the sample rate, cohort fingerprint, and frozen analysis protocol version before the observation window begins. Do not change them during the window.

### 1.6 Startup verification

After deploying with the configuration above:

1. Start the shadow worker process: `node dist/src/main-pmxt-shadow.js`
2. Verify the log output shows `[pmxt-shadow] Starting one shadow run.` (not `PMXT shadowing is disabled; exiting.`)
3. Verify the first run completes with a `claimed`, `skipped`, or `disabled` status.
4. Check Sentry for the shadow-specific monitor slug — confirm it is reporting separately from the authoritative scan monitor.
5. Verify zero PMXT-triggered orders, alerts, positions, or production opportunities.

---

## 2. Secret injection and rotation

### 2.1 Injection

- `PMXT_API_KEY` must be stored using the deployment's approved secret-injection mechanism (e.g., Docker secrets, environment file with restricted permissions, or a secrets manager). Never commit it to the repository.
- The key is read by `loadAppConfig` at process startup and passed to `createPmxtHostedClient`, which forwards it as `pmxtApiKey` to the PMXT SDK constructor.
- Never pass venue private keys (`KALSHI_PRIVATE_KEY`, `POLY_PRIVATE_KEY`), wallet addresses, or signing material to PMXT. The PMXT client only receives `PMXT_API_KEY`.
- Do not call account balance, position, or order endpoints through PMXT.

### 2.2 Rotation

To rotate the `PMXT_API_KEY`:

1. Obtain a new read-only hosted key from the PMXT account dashboard.
2. Verify the new key works with a minimal smoke test (e.g., `runPmxtHostedProbe` with the new key).
3. Update the secret in the deployment's secret store.
4. Restart or redeploy the shadow worker process. **The new key does not take effect until the process restarts.**
5. Verify the worker logs show successful PMXT API calls.
6. Revoke the old key from the PMXT dashboard after confirming the new key is working.

### 2.3 Revocation

To revoke the key entirely (e.g., during rollback or teardown):

1. Set `PMXT_SHADOW_ENABLED=false` in the environment.
2. Restart or redeploy the shadow worker process.
3. Verify the process exits with `PMXT shadowing is disabled; exiting.`
4. Revoke the key from the PMXT dashboard.
5. Remove the secret from the deployment's secret store.

---

## 3. Worker health monitoring

### 3.1 Health signals

The shadow worker (`src/main-pmxt-shadow.ts`) is a single-run process: it claims one authoritative scan, runs the shadow comparison, and exits. Health is monitored through:

- **Process exit code:** `0` for normal completion (including disabled/skipped), `1` for fatal error.
- **Sentry shadow monitor:** Distinct slug/tags (see §6).
- **`pmxt_shadow_run_attempts` table:** Each run records `status` (`claimed`, `completed`, `partial`, `failed`, `skipped`), `worker_id`, `claimed_at`, and `leased_until`.
- **Application logs:** `[pmxt-shadow]` prefixed log lines with run status JSON.

### 3.2 Health checks

| Check | How | Expected |
|---|---|---|
| Process completes | Check exit code or container status | Exit 0 within `PMXT_SHADOW_TIMEOUT_MS` |
| Run claimed | Query `pmxt_shadow_run_attempts` | New rows appear when authoritative scans are available |
| No stuck leases | Query leases past expiry | `SELECT count(*) FROM pmxt_shadow_run_attempts WHERE leased_until < now() AND status = 'claimed'` returns 0 after lease duration |
| Rate limiter healthy | Sentry metrics / logs | No sustained `circuit_open` or `global_cooldown` |
| No auth failures | Sentry tags `provider=pmxt-shadow` | Zero 401/403 errors |

### 3.3 Stuck lease recovery

If a shadow worker crashes mid-run, its lease will expire after `leaseDurationMs` (default 5 minutes). A subsequent worker run will claim the same authoritative scan as a new attempt (incrementing `attempt_number`). No manual intervention is required unless leases are consistently stuck.

To manually inspect stuck leases:

```sql
SELECT authoritative_scan_run_id, attempt_number, worker_id,
       claimed_at, leased_until, status
FROM pmxt_shadow_run_attempts
WHERE status = 'claimed' AND leased_until < now()
ORDER BY claimed_at;
```

---

## 4. Request, cost, and retention monitoring

### 4.1 Request monitoring

- Each shadow run records `requestCount` in the run result.
- The `PmxtShadowRateLimiter` enforces: token-bucket rate (`PMXT_SHADOW_REQUESTS_PER_MINUTE`, default 60), max concurrency (`PMXT_SHADOW_MAX_CONCURRENCY`, default 1), per-run request cap (`PMXT_SHADOW_MAX_REQUESTS_PER_RUN`), global cooldown on 429, and circuit breaker after sustained rate limiting.
- Rate-limit reason codes: `rate_limited`, `global_cooldown`, `circuit_open`, `max_concurrency`, `run_request_budget_exhausted`.
- Monitor Sentry for error tags `provider=pmxt-shadow` and reason codes above.

### 4.2 Cost monitoring

- `PMXT_SHADOW_MAX_MONTHLY_CREDITS` sets the approved monthly credit ceiling.
- `PMXT_SHADOW_MAX_MONTHLY_COST_USD` sets the approved monthly cost ceiling in USD.
- The rate limiter opens the circuit breaker permanently on HTTP 402 (payment required / monthly-quota exhaustion) — this is a fatal stop condition.
- Project monthly cost from observed per-run request counts × scan cadence × per-request cost.
- Alert when projected monthly cost exceeds 80% of the ceiling.

### 4.3 Retention monitoring

- `PMXT_SHADOW_RAW_RETENTION_DAYS` controls raw-payload persistence. When `0` (default), raw payloads are not persisted.
- When set to a positive value, raw payloads must be purged after the retention period expires.
- Audit retention: shadow run attempt records in `pmxt_shadow_run_attempts` are retained for the audit period agreed before the observation window. They are not automatically purged.
- Mapped fields, provenance, and comparison summaries are retained regardless of the raw-retention setting.
- See §8 (Data purge) for the purge procedure.

---

## 5. Pause and lease drain

### 5.1 Graceful pause

To pause shadowing without losing in-flight work:

1. Set `PMXT_SHADOW_ENABLED=false` in the environment.
2. **Do not kill the running process immediately.** Allow any in-flight shadow run to complete or time out. In-flight leases are preserved in `pmxt_shadow_run_attempts` and will not be re-claimed while `PMXT_SHADOW_ENABLED=false`.
3. Restart or redeploy the shadow worker process so it picks up the disabled flag. The process will exit with `PMXT shadowing is disabled; exiting.` and make no network calls.
4. Any in-flight lease that was active when the process was stopped will expire after `leaseDurationMs` (default 5 minutes). A future re-enablement will re-claim it as a new attempt.

### 5.2 In-flight lease drain

When pausing, check for active leases:

```sql
SELECT authoritative_scan_run_id, attempt_number, worker_id,
       claimed_at, leased_until, status
FROM pmxt_shadow_run_attempts
WHERE status = 'claimed' AND leased_until > now();
```

Wait for all listed leases to expire (their `leased_until` timestamp) before proceeding with teardown or config changes that would invalidate the cohort.

### 5.3 Cohort invalidation

If the frozen analysis protocol or cohort fingerprint must change (e.g., config, SDK, mapper, or domain-logic version changes):

1. Pause shadowing (§5.1).
2. Wait for all in-flight leases to drain (§5.2).
3. Start a new observation window with the new cohort fingerprint. Do not edit the running window — post-hoc changes to denominators, eligibility rules, or tolerances invalidate prior comparisons.
4. Document the reason for the new window in the decision memo.

---

## 6. Shadow Sentry monitoring isolation

### 6.1 Distinct slug and tags

Shadow Sentry monitoring must use a distinct monitor slug and tags that are separate from the authoritative scan monitor. The authoritative scan uses `SENTRY_MONITOR_SLUG` (default `arbitrage-agents-scan`). The shadow worker must not send check-ins to the authoritative scan monitor.

- Configure a separate Sentry monitor slug for PMXT shadow (e.g., `arbitrage-agents-pmxt-shadow`).
- Tag all shadow errors with `provider=pmxt-shadow`, the operation name, and the venue.
- Do not mix PMXT errors with authoritative-scan failure dashboards.

### 6.2 Cannot change authoritative check-ins or scan status

The shadow worker is architecturally isolated from the authoritative scan path:

- The shadow worker (`src/main-pmxt-shadow.ts`) uses a separate entry point and does not start the `WorkerScanRunner`.
- The `PmxtShadowRunner` only reads from `scan_runs` (to find the oldest succeeded scan) and writes only to `pmxt_shadow_run_attempts`.
- The shadow worker uses a separate worker ID (`PMXT_SHADOW_WORKER_ID`) that is distinct from the authoritative worker ID (`WORKER_ID`). The shadow worker never appears to own an authoritative scan lease.
- Shadow Sentry monitoring cannot change authoritative check-ins: the shadow worker does not call `SentryCheckInClient` with the authoritative monitor slug.
- Shadow Sentry monitoring cannot change scan status: the shadow worker never writes to `scan_runs.status`, `scan_steps`, or any production candidate/opportunity/alert table.

If any PMXT failure appears to propagate into authoritative scan status, this is a critical bug — trigger an immediate rollback (§7) and investigate.

---

## 7. Rollback

### 7.1 Immediate rollback

When a safety issue is detected and shadowing must stop immediately:

1. **Stop or scale the shadow worker.** Kill the `main-pmxt-shadow` process or scale its container to 0 replicas.
2. **Disable PMXT flags.** Set the following environment variables:
   ```text
   PMXT_SHADOW_ENABLED=false
   PMXT_SHADOW_READS_ENABLED=false
   PMXT_SHADOW_ROUTER_ENABLED=false
   ```
3. **Restart or redeploy** the shadow worker process so the disabled flags take effect. Disabling env vars alone is not effective without a restart or redeploy.
4. **Verify zero PMXT requests.** Check Sentry and application logs for any `[pmxt-shadow]` activity after the restart. Confirm the process exits with `PMXT shadowing is disabled; exiting.` and no PMXT API calls are made.
5. **Optionally revoke the key.** If the rollback is due to a key compromise or terms violation, revoke the `PMXT_API_KEY` from the PMXT dashboard (see §2.3).

### 7.2 Operational rollback

When a defect or policy change requires stopping shadowing but preserving the observation window's integrity:

1. Disable new shadow runs by setting `PMXT_SHADOW_ENABLED=false`.
2. Allow in-flight logical-run leases to complete or time out; do not abort them in a way that loses attempt history (see §5.2).
3. Preserve already-persisted shadow data for the agreed audit retention period.
4. Document the reason and restart condition in this runbook and the decision memo.
5. If the frozen analysis protocol or cohort fingerprint must change, start a new observation window rather than editing the running one (see §5.3).

### 7.3 Verification after rollback

After rollback, verify:

- No `[pmxt-shadow]` log lines appear after the restart.
- No new rows in `pmxt_shadow_run_attempts` with `claimed_at` after the restart timestamp.
- Authoritative scans continue normally — check `scan_runs` for recent succeeded entries.
- No PMXT errors in Sentry after the restart.

---

## 8. Automatic stop conditions

Disable or automatically pause shadowing if any of the following occurs. Resume only after root cause and remediation are documented.

### 8.1 Terms changes

- **Terms or service behavior change materially during the trial.** If PMXT updates its terms, pricing, rate limits, data-retention policy, or service-level commitments, stop shadowing and re-review the terms acceptance (PMXT-MIGRATION-PLAN.md §12.1) before resuming.

### 8.2 Sidecar behavior

- **The SDK attempts to start a local sidecar despite `autoStartServer=false`.** The hosted client factory (`src/contexts/venues/infrastructure/pmxt/pmxt-hosted-client-factory.ts`) hardcodes `autoStartServer: false`. If process observation reveals an unintended local child process or server, this is a critical setup failure. Stop immediately.

### 8.3 Secrets or account data in payloads

- **Raw responses contain secrets or account data not approved for storage.** If PMXT responses include API keys, wallet addresses, account balances, positions, or other sensitive data that was not explicitly approved for storage, stop shadowing immediately. Purge any stored raw payloads containing the sensitive data (see §9).

### 8.4 Inversions or units defects

- **A confirmed outcome inversion or unit-conversion defect is found.** If YES/NO book orientation is inverted, or if price, size, or depth units are mapped incorrectly, stop shadowing. These are safety-critical defects — a YES/NO inversion can cause incorrect opportunity calculation.

### 8.5 Cost or quota excess

- **Unexpected request volume or projected cost exceeds the trial budget.** If projected monthly cost exceeds `PMXT_SHADOW_MAX_MONTHLY_COST_USD`, or if the monthly credit quota is exhausted (HTTP 402), stop shadowing. The rate limiter opens the circuit breaker permanently on 402.
- **Sustained rate limiting makes results non-representative.** If the circuit breaker is open for a sustained period, shadow results are not representative of normal operation. Pause and investigate.

### 8.6 Authoritative propagation

- **PMXT failures propagate into authoritative scan status.** If an authoritative scan fails or is delayed because of PMXT activity, stop shadowing immediately. This is a critical isolation failure.
- **PMXT calls materially delay the next authoritative scan.** If the shadow worker's resource usage (CPU, memory, database connections) impacts the authoritative worker, stop shadowing.
- **API key or authorization failure persists.** Sustained 401/403 errors indicate a credential or permissions problem. Stop and remediate.

---

## 9. Data purge

### 9.1 Raw-data purge

When `PMXT_SHADOW_RAW_RETENTION_DAYS` is set to a positive value, raw PMXT payloads must be purged after the retention period expires. Raw payloads are stored in `pmxt_shadow_orderbooks.raw_payload` and `pmxt_shadow_markets.raw_payload` (when those tables exist).

To purge expired raw payloads:

```sql
-- Purge raw orderbook payloads older than the retention period.
UPDATE pmxt_shadow_orderbooks
SET raw_payload = NULL
WHERE received_at < now() - INTERVAL 'N days';

-- Purge raw market payloads older than the retention period.
UPDATE pmxt_shadow_markets
SET raw_payload = NULL
WHERE received_at < now() - INTERVAL 'N days';
```

Replace `N` with the value of `PMXT_SHADOW_RAW_RETENTION_DAYS`.

Mapped fields, provenance, and comparison summaries are retained — only the raw JSONB payloads are nulled.

### 9.2 Purge on stop condition

If a stop condition is triggered by secrets or account data in payloads (§8.3), immediately purge all raw payloads that may contain the sensitive data:

```sql
-- Emergency purge: null all raw payloads.
UPDATE pmxt_shadow_orderbooks SET raw_payload = NULL;
UPDATE pmxt_shadow_markets SET raw_payload = NULL;
```

Then investigate which records contained the sensitive data and document the incident.

### 9.3 Audit retention

Shadow run attempt records in `pmxt_shadow_run_attempts` are retained for the audit period agreed before the observation window. They are not automatically purged. After the audit period expires, they may be deleted as part of the final teardown (§10).

---

## 10. Final teardown

Final teardown is performed only after the evaluation is complete, the decision memo has been written, and the audit retention period has expired. Teardown is irreversible.

### 10.1 Prerequisites

- [ ] The observation window is complete (all conditions in PMXT-MIGRATION-PLAN.md §15 are met).
- [ ] The decision memo has been written with measured gates, unresolved issues, commercial findings, and a chosen outcome (A–F).
- [ ] The audit retention period has expired.
- [ ] No active shadow leases exist:
  ```sql
  SELECT count(*) FROM pmxt_shadow_run_attempts
  WHERE status = 'claimed' AND leased_until > now();
  -- Must return 0.
  ```

### 10.2 Disable shadowing

1. Set `PMXT_SHADOW_ENABLED=false`, `PMXT_SHADOW_READS_ENABLED=false`, `PMXT_SHADOW_ROUTER_ENABLED=false`.
2. Restart or redeploy the shadow worker process.
3. Verify the process exits with `PMXT shadowing is disabled; exiting.`

### 10.3 Revoke the key

1. Revoke the `PMXT_API_KEY` from the PMXT dashboard.
2. Remove the secret from the deployment's secret store.

### 10.4 Table teardown

Drop the dedicated shadow tables. The `pmxt_shadow_run_attempts` table has a foreign key to `scan_runs` with `ON DELETE CASCADE`, so it is safe to drop independently.

```sql
-- Drop shadow tables in reverse dependency order.
-- If pmxt_shadow_orderbooks, pmxt_shadow_markets, pmxt_router_clusters,
-- pmxt_router_cluster_edges, pmxt_shadow_candidates, pmxt_shadow_opportunities,
-- or pmxt_shadow_comparisons exist, drop them first.

DROP TABLE IF EXISTS pmxt_shadow_comparisons;
DROP TABLE IF EXISTS pmxt_shadow_opportunities;
DROP TABLE IF EXISTS pmxt_shadow_candidates;
DROP TABLE IF EXISTS pmxt_router_cluster_edges;
DROP TABLE IF EXISTS pmxt_router_clusters;
DROP TABLE IF EXISTS pmxt_shadow_orderbooks;
DROP TABLE IF EXISTS pmxt_shadow_markets;
DROP TABLE IF EXISTS pmxt_shadow_run_attempts;
```

### 10.5 Remove configuration

- Remove all `PMXT_*` environment variables from the deployment configuration.
- Remove PMXT-related entries from `.env.example` if the evaluation concluded with Outcome F (reject PMXT) and no future use is planned.
- Remove the PMXT shadow worker service from `docker-compose.yml` if it was added.

### 10.6 Verify

- Confirm no `pmxt_shadow_*` tables exist in the database.
- Confirm no `PMXT_*` environment variables are set.
- Confirm the shadow worker process is not running.
- Confirm authoritative scans continue normally.

---

## 11. Terms changes

If PMXT changes its terms of service, pricing, rate limits, data-retention policy, or service behavior during the evaluation:

1. **Stop shadowing immediately** (§7.1). Terms changes are an automatic stop condition (§8.1).
2. Review the updated terms against the operating boundary in PMXT-MIGRATION-PLAN.md §12.1.
3. If the changes are material (new restrictions, pricing changes, data-retention policy changes, new commercial/competition clauses), re-record the project owner's terms acceptance before resuming.
4. If the changes are immaterial or favorable, document the review and resume.
5. If the terms changes require a new cohort fingerprint or analysis protocol, start a new observation window (§5.3).
6. If the terms changes are unacceptable, proceed to final teardown (§10).
