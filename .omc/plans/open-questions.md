## Opportunity Risk Fee Slippage Readonly Slice - 2026-06-03
- [ ] What venue-specific fee schedule should eventually be modeled for Kalshi and Polymarket, and should fees be charged on cost, payout, profit, or each leg's notional? — The current calculator has only generic feeRate/slippageRate options, so production fee accuracy is intentionally deferred.
- [ ] Should `availableUsd` represent spendable quote currency at displayed ask, maximum payout exposure, or a precomputed venue-specific notional? — The model currently uses it directly for max tradable size, so semantics affect opportunity sizing.
- [ ] What default minimum net edge should be required before alerting? — The current calculator surfaces any positive net edge, which can create noisy or false-precision alerts.
- [ ] Should stale-book max age remain 60 seconds or become venue/config-specific? — Venue latency and update cadence may require different thresholds.
- [ ] Should public API responses include explicit `readOnly`, `indicative`, or `notForExecution` metadata in addition to model provenance? — Downstream consumers may otherwise confuse scanner output with trade recommendations.
