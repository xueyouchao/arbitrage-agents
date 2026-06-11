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
  llmEnabled: booleanFromString.default(false),
  llmProvider: z.enum(["ollama"]).default("ollama"),
  llmBaseUrl: z.string().url().default("http://127.0.0.1:11434/api/chat"),
  llmModel: z.string().min(1).default("minimax-m3:cloud"),
  llmRequestTimeoutMs: z.coerce.number().int().positive().max(180_000).default(30_000),
  scannerLlmPromptVersion: z.string().min(1).default("scanner-v1"),
  scannerLlmMaxEvaluationsPerScan: z.coerce.number().int().min(0).max(1_000).default(25)
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
    llmEnabled: env.LLM_ENABLED,
    llmProvider: env.LLM_PROVIDER,
    llmBaseUrl: env.LLM_BASE_URL,
    llmModel: env.LLM_MODEL,
    llmRequestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    scannerLlmPromptVersion: env.SCANNER_LLM_PROMPT_VERSION,
    scannerLlmMaxEvaluationsPerScan: env.SCANNER_LLM_MAX_EVALUATIONS_PER_SCAN
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
