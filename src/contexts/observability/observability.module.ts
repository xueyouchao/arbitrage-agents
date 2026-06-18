// ObservabilityModule wires the ObservabilityService to a real Sentry
// SDK sink when SENTRY_DSN is configured. In environments without a
// DSN (local dev, tests) the service still works — it captures events
// in its internal array — but nothing is shipped to Sentry.
//
// The module is @Global() so any context (scanner, api, llm, …) can
// inject OBSERVABILITY_SERVICE without re-importing the module.
//
// Sentry lifecycle:
//   onModuleInit        → Sentry.init({ dsn, environment })
//   onApplicationShutdown → Sentry.close(2000) to flush the transport
//
// The DSN is read from the existing AppConfig.sentryDsn field, which
// is loaded from the SENTRY_DSN environment variable. No additional
// env vars are required.

import { Global, Inject, Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { AppConfig } from "../../config/app-config";
import { APP_CONFIG } from "../../config/config.module";
import { ObservabilityService } from "./observability.service";
import { SentryObservabilitySink } from "./sentry-observability-sink";

// Opaque DI token so consumers depend on the interface, not the class.
export const OBSERVABILITY_SERVICE = Symbol("OBSERVABILITY_SERVICE");

@Global()
@Module({
  providers: [
    {
      provide: OBSERVABILITY_SERVICE,
      useFactory: (config: AppConfig): ObservabilityService => {
        if (config.sentryDsn) {
          return new ObservabilityService(new SentryObservabilitySink());
        }
        return new ObservabilityService();
      },
      inject: [APP_CONFIG]
    }
  ],
  exports: [OBSERVABILITY_SERVICE]
})
export class ObservabilityModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (!this.config.sentryDsn) return;

    Sentry.init({
      dsn: this.config.sentryDsn,
      environment: this.config.nodeEnv,
      // sendDefaultPii is controlled by the existing config flag so
      // operators can opt in without a code change.
      sendDefaultPii: this.config.sentrySendDefaultPii,
      // tracesSampleRate controls what fraction of spans (LLM eval
      // traces) are shipped to Sentry. Default is 0 (disabled) so
      // the free tier is not exceeded. Set SENTRY_TRACES_SAMPLE_RATE
      // to a value between 0 and 1 to enable.
      tracesSampleRate: this.config.sentryTracesSampleRate,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.config.sentryDsn) return;
    // Give the transport up to 2 s to flush buffered events before
    // the process exits. Mirrors Sentry's own recommendation for
    // serverless / short-lived processes.
    await Sentry.close(2_000);
  }
}
