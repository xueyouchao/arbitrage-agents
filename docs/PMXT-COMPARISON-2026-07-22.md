# PMXT vs Native Scanner — Comparison Report (2026-07-22)

> Produced by `scripts/compare-pmxt-scanner.ts` — a no-DB dry-run harness that
> runs the PMXT read path and the native Kalshi/Polymarket read path through
> the **same** shared pipeline (normalizer → `CandidatePairGenerator` →
> `DeterministicEquivalencePolicy` → `OpportunityCalculator`) with frozen
> identical calculator options, then diffs candidate pairs + opportunities
> with per-pair reason codes.

## How to reproduce

```bash
# Native only (no credentials):
COMPARE_NATIVE_ONLY=1 node dist/scripts/compare-pmxt-scanner.js

# PMXT via hosted API (requires PMXT_API_KEY + PMXT_HOSTED_BASE_URL in env):
node dist/scripts/compare-pmxt-scanner.js

# PMXT via local pmxt-core sidecar (no credentials; real SDK + mappers):
COMPARE_PMXT_SOURCE=mock \
COMPARE_PMXT_MOCK_VENUE=kalshi,polymarket \
COMPARE_PMXT_POLY_QUERY=bitcoin \
node dist/scripts/compare-pmxt-scanner.js
```

Config knobs: `KALSHI_SERIES_TICKER` (default `KXBTCD`),
`POLYMARKET_SERIES_SLUG` (default `btc-multi-strikes-weekly`),
`COMPARE_MARKET_LIMIT`, `COMPARE_PMXT_VENUE`,
`COMPARE_PMXT_MOCK_VENUE` (`mock` | `kalshi` | `polymarket` | `kalshi,polymarket`),
`COMPARE_PMXT_POLY_QUERY`.

## Findings

### 1. Native scanner (live, series-scoped)
Kalshi `KXBTCD` (318 markets) + Polymarket `btc-multi-strikes-weekly` (77)
→ 395 normalized → **30 candidate pairs** → 0 opportunities. Every pair is a
genuine one-to-one within-$1 strike match across 3 expiry days (e.g. Kalshi
`73999.99` ↔ Polymarket `74000`). 0 opportunities because the books did not
present a profitable combined edge at the configured notionals.

### 2. PMXT scanner (local sidecar, Kalshi + Polymarket)
PMXT Kalshi global `fetchMarkets()` (4353 markets) + Polymarket `{query:"bitcoin"}`
(100 markets) → 4439 admitted → 62 books → **0 candidate pairs**.

**Root cause of 0 PMXT pairs:** the PMXT Kalshi global catalog contains **no
crypto price-level markets** (politics/election/timer markets only — "Above
300K / Not Above 300K" is vote-turnout, not BTC). The 100 Polymarket crypto
markets therefore have no Kalshi counterpart on the PMXT side, so no
cross-venue candidate forms. This is the **scoping gap** the PMXT migration
plan (§10.3, §5.4) explicitly warns about: PMXT's global catalog ≠ the
series-scoped native scan. A PMXT Router / series-scoped query would be
required to surface the same KXBTCD markets.

### 3. Coverage (0 overlap)
PMXT-vs-native venue-native-ID overlap was **0** on both venues. The native
scan is series-scoped (`KXBTCD`, `btc-multi-strikes-weekly`); PMXT was queried
globally. Overlap can only be measured after scoping PMXT to the same series
— which the hosted Router endpoint provides but the local sidecar's global
`fetchMarkets()` does not.

### 4. Scanner defect found + fixed: cross-product candidate pairing
While investigating the native 30-pair result, the harness exposed that
`CandidatePairGenerator.bucketKey` grouped threshold-bearing markets by
`topic|asset|eventType|payoffType` only — **omitting the strike** — so every
strike on a crypto day collapsed into one bucket and produced an
O(strikes²) cross-product that `thresholdsMatch` then filtered. Fix:
strike-band expansion bucketing in `candidate-pair-generator.ts`.

- Crypto price-level markets (≤$1 tolerance) bucket into a $1 band and emit
  to **both** floor and floor+1 bands so a within-$1 pair straddling a band
  boundary still collides.
- Exact-threshold topics use a 1e-6 band (single bucket).
- Non-threshold markets keep the original single bucket.
- The exact-match arbiters (`thresholdsMatch`/`deadlinesMatch`) are
  unchanged, so the admitted pair set is identical — only the cross-product
  blowup is removed. De-duplication handles the band-overlap case.

**Verification:** all 623 unit tests pass (60 files). 3 new regression tests
in `test/matching.test.ts` (boundary-straddling pair, no cross-product on 20
× 20 strikes, >$1 apart rejected). Live native run after the fix: 30 pairs,
each a genuine one-to-one within-$1 match (diff=0.01).

## Improvement to scanning (summary)
1. **`scripts/compare-pmxt-scanner.ts`** — runnable comparison harness
   (native live + PMXT hosted/local) with per-pair diff, not whole-array
   equality. Added `scripts/**` to `tsconfig.json`.
2. **`candidate-pair-generator.ts`** — strike-band bucketing eliminates the
   O(strikes²) cross-product without changing admitted pairs.

## Hosted PMXT comparison (live, 2026-07-22)

Once `PMXT_API_KEY` was in `.env`, the harness ran the **hosted** PMXT API
(`https://api.pmxt.dev`) end-to-end. Correct hosted configuration, confirmed
from https://www.pmxt.dev/docs/authentication and the `pmxtjs` SDK source
(`constants.js: resolvePmxtBaseUrl`):

- **Base URL:** `https://api.pmxt.dev` (reads, catalog, Router, MCP).
  `https://trade.pmxt.dev` is writes-only — not used.
- **Auth:** Bearer token, `Authorization: Bearer pmxt_live_...`. The SDK
  auto-resolves hosted mode from `PMXT_API_KEY` alone; `PMXT_HOSTED_BASE_URL`
  is optional (defaults to `api.pmxt.dev`).
- **`autoStartServer: false`** for hosted (factory already enforces it).
- Key prefix observed in this env: `pmxt_fada7...` (not `pmxt_live_...`) —
  still authenticated successfully against the hosted API.

### Hosted findings
- PMXT hosted `Kalshi.fetchMarkets({ query: "Bitcoin price", limit: 20 })`
  returns **real KXBTCD markets** (e.g. `KXBTCD-26JUL2217-T65999.99`) — the
  same series the native scanner uses, but a **different slice**.
- PMXT hosted `Polymarket.fetchMarkets({ query: "bitcoin", limit: 20 })`
  returns 20 crypto markets.
- **Coverage overlap by venue-native ID: 0** on both venues — but this is a
  **query-scope mismatch, not a data gap**:
  - Native (series-scoped `KXBTCD`, top-80): expiry `26JUL2211` (11:00 UTC),
    strikes `67399.99`–`75299.99` in **$100** steps.
  - PMXT (free-text `query:"Bitcoin price"`, top-20): expiry `26JUL2217`
    (17:00 UTC) + `26JUL2417`, strikes in **$250** steps from `64499.99`.
  - The two query methods surface **different expiries and strike ladders**,
    so no market ticker is shared. The hosted API rate-limits aggressively
    (429) when fetching large limits or per-market orderbooks, so books were
    skipped (`COMPARE_PMXT_SKIP_BOOKS=1`) and limits kept to 20.
- **Conclusion:** free-text PMXT `fetchMarkets({query})` is **not equivalent**
  to the native series-scoped scan. To measure true coverage parity, PMXT
  must be queried by the same series scope (the hosted Router /
  `fetchMarkets` with a series filter), not by free text. This is the
  concrete instance of migration-plan §10.3 ("coverage must be calculated
  over equivalent query scopes").

### Configuration caveats discovered
- The harness's `createPmxtHostedClient` factory wrapper drops the
  `{ query }` argument, so the hosted path now instantiates the `pmxtjs`
  exchange directly (`new Kalshi({ pmxtApiKey, baseUrl, autoStartServer:false })`)
  to pass the query. This is harness-only; the production shadow runner is
  untouched.
- The hosted catalog returns venue-native outcome labels
  ("$66,000 or above"/"Not $66,000 or above") and `sourceExchange: null`; the
  harness adapts these to yes/no orientation (via the `-NO` outcomeId suffix
  convention) and stamps `sourceExchange` + `venueMarketId` (from `slug`).
  Production mappers reject this shape — a real gap if the hosted path is
  ever wired into production.

## Current production shadow implementation

The dedicated production path now closes the wiring gap described above:

- `PmxtShadowAppModule` boots only config, database, observability, and
  `PmxtShadowModule`; the normal `ScannerModule` and `WorkerScanRunner` contain
  no PMXT providers.
- After claiming a succeeded authoritative scan ID, the shadow flow reads its
  native `VenueMarketSnapshot` rows through the read-only
  `PostgresPmxtAuthoritativeMarketSnapshotRepository`. Native snapshots remain
  native and are not passed to APIs that require `PmxtMarketSnapshot`.
- Both hosted exchange clients call `fetchEvents({series})` using exactly the
  configured `KALSHI_SERIES_TICKER` and `POLYMARKET_SERIES_SLUG`. Catalog
  records become PMXT snapshots only after explicit Kalshi ticker or
  Polymarket condition-ID stamps are proven from the venue payload.
- Reads coverage is persisted only over equivalent, proven series scope.
  Empty catalogs or unproven venue-native identities are persisted as
  `scope_unproven` exclusions and finalize the attempt as partial, never as
  completed parity.
- Router-only mode still fetches both exact catalogs to build anchored Router
  calls, then persists clusters and direct edges. It does not save or claim a
  reads-coverage result.
- Reads and Router execute concurrently and settle independently: one failure
  yields partial while the other continues; both failures yield failed.
- All writes remain under `pmxt_*`; this path does not connect to execution,
  alerts, opportunities, positions, or paper trading.

This production shadow is an exact market-catalog/coverage and anchored-Router
comparison. It does **not** supersede the dry-run harness findings above, does
not claim order-book parity, and does not turn PMXT into an authoritative
scanner input.

## Follow-ups
- Run the dedicated shadow over a frozen observation window and report measured
  equivalent-scope coverage and Router projection quality; do not combine it
  with the earlier global/free-text cohorts.
- Raise hosted limits or add order-book comparison only after the current API
  tier and request budget can support it without 429-biased sampling.