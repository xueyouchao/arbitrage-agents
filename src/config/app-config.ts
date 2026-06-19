import { z } from "zod";

const booleanFromString = z.preprocess((value) => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}, z.boolean());

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
  sentryMonitorSlug: z.string().min(1).default("arbitrage-agents-scan")
});

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
    sentryMonitorSlug: env.SENTRY_MONITOR_SLUG
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
