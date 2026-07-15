import { z } from "zod";
import { readFileSync } from "node:fs";
import type { ExitGateConfig } from "../contexts/arbitrage/domain/exit-gate-evaluator";

const booleanFromString = z.preprocess((value) => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}, z.boolean());

const sampleRateFromString = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return { numerator: 0, denominator: 1 };
  }

  if (typeof value !== "string") {
    return value;
  }

  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) {
    return value;
  }

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    return value;
  }

  return { numerator, denominator };
}, z.object({
  numerator: z.number().int().min(0),
  denominator: z.number().int().positive()
}).refine(
  ({ numerator, denominator }) => numerator <= denominator,
  "PMXT_SHADOW_SAMPLE_RATE numerator must not exceed denominator"
));

const optionalNumber = (schema: z.ZodNumber) => z.preprocess(
  (value) => value === undefined || value === "" ? undefined : value,
  schema.optional()
);

const optionalPositiveInt = optionalNumber(z.coerce.number().int().positive());

const hostedHttpUrl = z.string().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  "PMXT_HOSTED_BASE_URL must use HTTP or HTTPS"
);

const PmxtShadowConfigSchema = z.object({
  pmxtApiKey: z.string().default(""),
  pmxtHostedBaseUrl: z.union([z.literal(""), hostedHttpUrl]).default(""),
  pmxtShadowEnabled: booleanFromString.default(false),
  pmxtShadowReadsEnabled: booleanFromString.default(false),
  pmxtShadowRouterEnabled: booleanFromString.default(false),
  pmxtShadowSampleRate: sampleRateFromString,
  pmxtShadowTimeoutMs: z.coerce.number().int().positive().max(24 * 60 * 60 * 1000).default(60_000),
  pmxtRequestTimeoutMs: z.coerce.number().int().positive().max(180_000).default(10_000),
  pmxtShadowRequestsPerMinute: z.coerce.number().int().positive().max(60).default(60),
  pmxtShadowMaxConcurrency: z.coerce.number().int().positive().max(1).default(1),
  pmxtShadowMaxQueueDepth: optionalPositiveInt,
  pmxtShadowMaxQueueWaitMs: optionalPositiveInt,
  pmxtShadowMaxRequestsPerRun: optionalPositiveInt,
  pmxtShadowMaxMarketsPerVenue: optionalPositiveInt,
  pmxtShadowMaxBooksPerVenue: optionalPositiveInt,
  pmxtShadowMaxMonthlyCredits: optionalPositiveInt,
  pmxtShadowMaxMonthlyCostUsd: optionalNumber(z.coerce.number().finite().nonnegative()),
  pmxtShadowRawRetentionDays: z.coerce.number().int().min(0).default(0)
}).superRefine((config, context) => {
  const childModeEnabled = config.pmxtShadowReadsEnabled || config.pmxtShadowRouterEnabled;

  if (!config.pmxtShadowEnabled && childModeEnabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PMXT_SHADOW_ENABLED must be true when a PMXT child mode is enabled"
    });
  }

  if (!config.pmxtShadowEnabled) {
    return;
  }

  const required: Array<[unknown, string]> = [
    [config.pmxtApiKey, "PMXT_API_KEY is required when PMXT shadowing is enabled"],
    [config.pmxtHostedBaseUrl, "PMXT_HOSTED_BASE_URL is required when PMXT shadowing is enabled"],
    [childModeEnabled, "PMXT shadowing requires reads or Router mode"],
    [config.pmxtShadowSampleRate.numerator > 0, "PMXT_SHADOW_SAMPLE_RATE must be positive when enabled"],
    [config.pmxtShadowMaxQueueDepth, "PMXT_SHADOW_MAX_QUEUE_DEPTH is required when enabled"],
    [config.pmxtShadowMaxQueueWaitMs, "PMXT_SHADOW_MAX_QUEUE_WAIT_MS is required when enabled"],
    [config.pmxtShadowMaxRequestsPerRun, "PMXT_SHADOW_MAX_REQUESTS_PER_RUN is required when enabled"],
    [config.pmxtShadowMaxMonthlyCredits, "PMXT_SHADOW_MAX_MONTHLY_CREDITS is required when enabled"],
    [config.pmxtShadowMaxMonthlyCostUsd !== undefined, "PMXT_SHADOW_MAX_MONTHLY_COST_USD is required when enabled"]
  ];

  for (const [value, message] of required) {
    if (!value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  }
});

const AppConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().positive().max(65535).default(3000),
  databaseUrl: z.string().url(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  sentryDsn: z.string().url().optional(),
  sentrySendDefaultPii: booleanFromString.default(false),
  // Sentry trace sampling rate. 0 = no traces (free tier safe),
  // 1 = every span is sent. Keep low unless you have a paid plan
  // — at 25 evals/scan × 288 scans/day, rate=1 produces ~216K spans/month.
  sentryTracesSampleRate: z.coerce.number().min(0).max(1).default(0),
  llmPromptSampleRate: z.coerce.number().min(0).max(1).default(0),
  llmEnabled: booleanFromString.default(false),
  llmProvider: z.enum(["ollama"]).default("ollama"),
  llmBaseUrl: z.string().url().default("http://127.0.0.1:11434/api/chat"),
  llmModel: z.string().min(1).default("glm-5.2:cloud"),
  llmRequestTimeoutMs: z.coerce.number().int().positive().max(180_000).default(30_000),
  scannerLlmPromptVersion: z.string().min(1).default("scanner-v1"),
  scannerLlmMaxEvaluationsPerScan: z.coerce.number().int().min(0).max(1_000).default(25),
  // Phase 4: how long a `running` scan may go without a heartbeat
  // before the AbandonedScanDetector marks it abandoned. The default
  // (5 minutes) is generous enough to cover a normal scan even with
  // a slow LLM batch; smaller values trade false positives for
  // faster recovery on stuck runs.
  scannerAbandonedAfterMs: z.coerce.number().int().positive().max(24 * 60 * 60 * 1000).default(5 * 60 * 1000),
  // Phase 4: Sentry cron-monitor slug. Defaults to a stable
  // production-style slug; the worker sends an in_progress check-in
  // at the start of each scan and an ok / error check-in at the end.
  sentryMonitorSlug: z.string().min(1).default("arbitrage-agents-scan"),
  // Kalshi trading API credentials. Optional — empty by default so the app
  // boots without keys; the trading client is only used when configured.
  kalshiApiKeyId: z.string().default(""),
  kalshiPrivateKey: z.string().default(""),
  // Polymarket CLOB trading credentials (issue #78). Optional — the
  // trading client is built with a placeholder signer until wallet keys
  // are provisioned (HITL gate). Defaults to empty string so the app
  // boots without them.
  polyPrivateKey: z.string().default(""),
  polyWalletAddress: z.string().default(""),
  // Issue #81: max capital deployed across all open positions. If
  // total open position notional exceeds this, new executions are
  // rejected by the RiskManager pre-trade guard.
  maxCapitalDeployedUsd: z.coerce.number().positive().default(5000),
  // Issue #82: pre-flight freshness guards for execution. Set a positive
  // finite value (ms) to enable fail-closed rejection of stale quotes
  // (dataStalenessMs) or aged opportunities (opportunityAgeMs). Omit,
  // leave empty, or set 0 to disable the guard and preserve prior behavior.
  maxQuoteStalenessMs: z.coerce.number().finite().min(0).max(24 * 60 * 60 * 1000).default(0),
  maxOpportunityAgeMs: z.coerce.number().finite().min(0).max(24 * 60 * 60 * 1000).default(0),
  // Crypto price-level markets (BTC/ETH daily price series) only surface
  // via series-scoped queries — they almost never appear in either venue's
  // global top-100 list. Without these the production worker normalizes ~0
  // crypto markets and emits 0 candidate pairs every scan. Defaults target
  // the BTC daily price-level series on each venue; override per-env to scan
  // ETH (KXETHD / eth-multi-strikes-weekly) or disable (empty string → the
  // client falls back to the global top-100, matching the old behavior).
  kalshiSeriesTicker: z.string().default("KXBTCD"),
  polymarketSeriesSlug: z.string().default("btc-multi-strikes-weekly"),
  // ADR-0002 §3.3 exit-gate tunables. These were previously hard-coded in the
  // evaluator; surfacing them in AppConfig lets operations adjust the gate
  // without a code change. §3.1/§4.1 selects the top-level policy:
  //   evaluate = run the exit-cost + liquidity gate (phase-1 default, alert-first),
  //   hold     = never evaluate t1 exit (disables the feature globally).
  // "always" (unconditional exit) is intentionally NOT exposed in phase 1 — ADR
  // §3.1 makes conditional exit the default and §4.1 defers unconditional exit
  // until a future ADR approves it.
  t1ExitMinMargin: z.coerce.number().min(0).max(1).default(0.005),
  t1ExitDepthHaircut: z.coerce.number().min(0).max(1).default(0.25),
  t1ExitPolicy: z.enum(["evaluate", "hold"]).default("evaluate"),
  // ADR §6 Open Question #1: simple gap-decay proxy for hold expected value.
  t1ExitGapDecayPerHour: z.coerce.number().min(0).max(1).default(0.02),
  t1ExitGapDecayMax: z.coerce.number().min(0).max(1).default(0.5),
  // ADR §3.3 exit-cost components. sellFee and estimatedSpread are fractions of
  // price; estimatedSlippage is a per-share cost (dollars per share sold), NOT a
  // price fraction — slippage scales with size, per ADR §3.3. Named "...PerShare"
  // so the unit is explicit.
  t1ExitSellFeeRate: z.coerce.number().min(0).max(1).default(0.01),
  t1ExitEstimatedSpreadRate: z.coerce.number().min(0).max(1).default(0.01),
  t1ExitEstimatedSlippagePerShare: z.coerce.number().min(0).max(1).default(0.005)
}).and(PmxtShadowConfigSchema);

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return AppConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    sentryDsn: emptyToUndefined(env.SENTRY_DSN),
    sentrySendDefaultPii: env.SENTRY_SEND_DEFAULT_PII,
    sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    llmPromptSampleRate: env.LLM_PROMPT_SAMPLE_RATE,
    llmEnabled: env.LLM_ENABLED,
    llmProvider: env.LLM_PROVIDER,
    llmBaseUrl: env.LLM_BASE_URL,
    llmModel: env.LLM_MODEL,
    llmRequestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    scannerLlmPromptVersion: env.SCANNER_LLM_PROMPT_VERSION,
    scannerLlmMaxEvaluationsPerScan: env.SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN,
    scannerAbandonedAfterMs: env.SCANNER_ABANDONED_AFTER_MS,
    sentryMonitorSlug: env.SENTRY_MONITOR_SLUG,
    kalshiApiKeyId: env.KALSHI_API_KEY_ID,
    kalshiPrivateKey: resolveKalshiPrivateKey(env.KALSHI_PRIVATE_KEY),
    polyPrivateKey: env.POLY_PRIVATE_KEY,
    polyWalletAddress: env.POLY_WALLET_ADDRESS,
    maxCapitalDeployedUsd: env.MAX_CAPITAL_DEPLOYED_USD,
    maxQuoteStalenessMs: env.MAX_QUOTE_STALENESS_MS,
    maxOpportunityAgeMs: env.MAX_OPPORTUNITY_AGE_MS,
    kalshiSeriesTicker: env.KALSHI_SERIES_TICKER,
    polymarketSeriesSlug: env.POLYMARKET_SERIES_SLUG,
    t1ExitMinMargin: env.T1_EXIT_MIN_MARGIN,
    t1ExitDepthHaircut: env.T1_EXIT_DEPTH_HAIRCUT,
    t1ExitPolicy: env.T1_EXIT_POLICY,
    t1ExitGapDecayPerHour: env.T1_EXIT_GAP_DECAY_PER_HOUR,
    t1ExitGapDecayMax: env.T1_EXIT_GAP_DECAY_MAX,
    t1ExitSellFeeRate: env.T1_EXIT_SELL_FEE_RATE,
    t1ExitEstimatedSpreadRate: env.T1_EXIT_ESTIMATED_SPREAD_RATE,
    t1ExitEstimatedSlippagePerShare: env.T1_EXIT_ESTIMATED_SLIPPAGE_PER_SHARE,
    pmxtApiKey: env.PMXT_API_KEY,
    pmxtHostedBaseUrl: env.PMXT_HOSTED_BASE_URL,
    pmxtShadowEnabled: env.PMXT_SHADOW_ENABLED,
    pmxtShadowReadsEnabled: env.PMXT_SHADOW_READS_ENABLED,
    pmxtShadowRouterEnabled: env.PMXT_SHADOW_ROUTER_ENABLED,
    pmxtShadowSampleRate: env.PMXT_SHADOW_SAMPLE_RATE,
    pmxtShadowTimeoutMs: env.PMXT_SHADOW_TIMEOUT_MS,
    pmxtRequestTimeoutMs: env.PMXT_REQUEST_TIMEOUT_MS,
    pmxtShadowRequestsPerMinute: env.PMXT_SHADOW_REQUESTS_PER_MINUTE,
    pmxtShadowMaxConcurrency: env.PMXT_SHADOW_MAX_CONCURRENCY,
    pmxtShadowMaxQueueDepth: env.PMXT_SHADOW_MAX_QUEUE_DEPTH,
    pmxtShadowMaxQueueWaitMs: env.PMXT_SHADOW_MAX_QUEUE_WAIT_MS,
    pmxtShadowMaxRequestsPerRun: env.PMXT_SHADOW_MAX_REQUESTS_PER_RUN,
    pmxtShadowMaxMarketsPerVenue: env.PMXT_SHADOW_MAX_MARKETS_PER_VENUE,
    pmxtShadowMaxBooksPerVenue: env.PMXT_SHADOW_MAX_BOOKS_PER_VENUE,
    pmxtShadowMaxMonthlyCredits: env.PMXT_SHADOW_MAX_MONTHLY_CREDITS,
    pmxtShadowMaxMonthlyCostUsd: env.PMXT_SHADOW_MAX_MONTHLY_COST_USD,
    pmxtShadowRawRetentionDays: env.PMXT_SHADOW_RAW_RETENTION_DAYS
  });
}

export function pmxtShadowConfigForFingerprint(config: AppConfig) {
  return {
    pmxtHostedBaseUrl: config.pmxtHostedBaseUrl,
    pmxtShadowEnabled: config.pmxtShadowEnabled,
    pmxtShadowReadsEnabled: config.pmxtShadowReadsEnabled,
    pmxtShadowRouterEnabled: config.pmxtShadowRouterEnabled,
    pmxtShadowSampleRate: config.pmxtShadowSampleRate,
    pmxtShadowTimeoutMs: config.pmxtShadowTimeoutMs,
    pmxtRequestTimeoutMs: config.pmxtRequestTimeoutMs,
    pmxtShadowRequestsPerMinute: config.pmxtShadowRequestsPerMinute,
    pmxtShadowMaxConcurrency: config.pmxtShadowMaxConcurrency,
    pmxtShadowMaxQueueDepth: config.pmxtShadowMaxQueueDepth,
    pmxtShadowMaxQueueWaitMs: config.pmxtShadowMaxQueueWaitMs,
    pmxtShadowMaxRequestsPerRun: config.pmxtShadowMaxRequestsPerRun,
    pmxtShadowMaxMarketsPerVenue: config.pmxtShadowMaxMarketsPerVenue,
    pmxtShadowMaxBooksPerVenue: config.pmxtShadowMaxBooksPerVenue,
    pmxtShadowMaxMonthlyCredits: config.pmxtShadowMaxMonthlyCredits,
    pmxtShadowMaxMonthlyCostUsd: config.pmxtShadowMaxMonthlyCostUsd,
    pmxtShadowRawRetentionDays: config.pmxtShadowRawRetentionDays
  };
}

/**
 * Map AppConfig's ADR-0002 T1 exit-gate fields into the ExitGateConfig shape
 * expected by evaluateExitGate. This is a convenience for the scanner wiring
 * so the evaluator can keep its pure function signature while still receiving
 * config-driven tunables.
 */
export function exitGateConfigFromApp(config: AppConfig): Partial<ExitGateConfig> {
  return {
    minMargin: config.t1ExitMinMargin,
    depthHaircut: config.t1ExitDepthHaircut,
    gapDecayPerHour: config.t1ExitGapDecayPerHour,
    gapDecayMax: config.t1ExitGapDecayMax,
    sellFeeRate: config.t1ExitSellFeeRate,
    estimatedSpreadRate: config.t1ExitEstimatedSpreadRate,
    estimatedSlippagePerShare: config.t1ExitEstimatedSlippagePerShare
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

/**
 * Resolve the Kalshi RSA private key. If the env value looks like a file path
 * (starts with "/" or "." and ends with ".pem"), read the file contents.
 * Otherwise treat the value as the inline key.
 */
function resolveKalshiPrivateKey(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "";
  }
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("/") || trimmed.startsWith(".")) &&
    trimmed.endsWith(".pem")
  ) {
    try {
      return readFileSync(trimmed, "utf-8").trim();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
