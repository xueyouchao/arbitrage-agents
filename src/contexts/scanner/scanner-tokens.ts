export const KALSHI_VENUE_CLIENT = Symbol("KALSHI_VENUE_CLIENT");
export const POLYMARKET_VENUE_CLIENT = Symbol("POLYMARKET_VENUE_CLIENT");
export const SCANNER_REPOSITORY = Symbol("SCANNER_REPOSITORY");
export const LLM_EVALUATION_REPOSITORY = Symbol("LLM_EVALUATION_REPOSITORY");
export const SCANNER_LLM_GATEWAY = Symbol("SCANNER_LLM_GATEWAY");
// Phase 4: the new step-trail repository, the Sentry check-in client,
// and the dedicated observability surface for the resumable worker.
export const SCAN_STEP_REPOSITORY = Symbol("SCAN_STEP_REPOSITORY");
export const SENTRY_CHECK_IN_CLIENT = Symbol("SENTRY_CHECK_IN_CLIENT");
// Issue #93: PMXT shadow runner lease repository and runner symbols.
export const PMXT_SHADOW_LEASE_REPOSITORY = Symbol("PMXT_SHADOW_LEASE_REPOSITORY");
export const PMXT_SHADOW_RUNNER = Symbol("PMXT_SHADOW_RUNNER");
