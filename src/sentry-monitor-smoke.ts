import { SentryHttpCheckInClient } from "./contexts/observability/sentry-check-in-client";

export interface SentryMonitorSmokeConfig {
  dsn: string;
  monitorSlug: string;
}

export interface SentryMonitorSmokeOptions {
  config?: SentryMonitorSmokeConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SentryMonitorSmokeResult {
  monitorSlug: string;
  checkInId: string;
}

export function loadSentryMonitorSmokeConfig(env: NodeJS.ProcessEnv = process.env): SentryMonitorSmokeConfig {
  const dsn = env.SENTRY_DSN?.trim();
  const monitorSlug = env.SENTRY_MONITOR_SLUG?.trim();
  if (!dsn || !monitorSlug) {
    throw new Error("SENTRY_DSN and SENTRY_MONITOR_SLUG must be set to verify the Sentry cron monitor");
  }
  return { dsn, monitorSlug };
}

export async function runSentryMonitorSmokeCheck(options: SentryMonitorSmokeOptions = {}): Promise<SentryMonitorSmokeResult> {
  const config = options.config ?? loadSentryMonitorSmokeConfig(options.env);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const client = new SentryHttpCheckInClient({ dsn: config.dsn, fetchImpl: options.fetchImpl, now });
  const handle = await client.start(config.monitorSlug, startedAt);
  await client.ok(handle, now());
  return { monitorSlug: handle.slug, checkInId: handle.checkInId };
}

if (require.main === module) {
  runSentryMonitorSmokeCheck()
    .then((result) => {
      console.log(`Sentry monitor smoke check sent for ${result.monitorSlug} (${result.checkInId})`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Sentry monitor smoke check failed: ${message}`);
      process.exitCode = 1;
    });
}
