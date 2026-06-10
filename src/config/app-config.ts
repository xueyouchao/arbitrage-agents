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
  llmPromptSampleRate: z.coerce.number().min(0).max(1).default(0),
  llmModel: z.string().min(1).default("scanner-noop"),
  scannerLlmPromptVersion: z.string().min(1).default("scanner-v1"),
  venueHttpTimeoutMs: z.coerce.number().int().positive().default(5_000),
  venueHttpRetries: z.coerce.number().int().min(0).default(2),
  venueHttpRetryDelayMs: z.coerce.number().int().min(0).default(100),
  venueHttpVerbose: booleanFromString.default(false)
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
    llmPromptSampleRate: env.LLM_PROMPT_SAMPLE_RATE,
    llmModel: env.LLM_MODEL,
    scannerLlmPromptVersion: env.SCANNER_LLM_PROMPT_VERSION,
    venueHttpTimeoutMs: env.VENUE_HTTP_TIMEOUT_MS,
    venueHttpRetries: env.VENUE_HTTP_RETRIES,
    venueHttpRetryDelayMs: env.VENUE_HTTP_RETRY_DELAY_MS,
    venueHttpVerbose: env.VENUE_HTTP_VERBOSE
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
