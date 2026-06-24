import { Module } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { LlmEvaluationRepository } from "../llm/application/llm-evaluation";
import { LlmCostCalculator, DEFAULT_PRICING } from "../llm/application/llm-cost-calculator";
import { PersistedLlmGateway } from "../llm/application/persisted-llm-gateway";
import { OllamaChatLlmProvider } from "../llm/infrastructure/ollama-chat-llm-provider";
import { PostgresLlmEvaluationRepository } from "../llm/infrastructure/postgres-llm-evaluation-repository";
import { SentryLlmTraceReporter } from "../llm/infrastructure/sentry-llm-trace-reporter";
import { buildScannerLlmValidatorRegistry } from "../llm/scanner-llm-validators";
import { FakeSentryCheckInClient, SentryCheckInClient, SentryHttpCheckInClient } from "../observability/sentry-check-in-client";
import { SentryScanTelemetryReporter } from "./sentry-scan-telemetry-reporter";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../venues/infrastructure/http-venue-clients";
import { VenueClient } from "../venues/domain/venue-market";
import { AbandonedScanDetector } from "./abandoned-scan-detector";
import { PaperTradeSimulator } from "../arbitrage/domain/paper-trade-simulator";
import { PostgresScanStepRepository } from "./postgres-scan-step-repository";
import { PostgresScannerRepository } from "./postgres-scanner-repository";
import { ReadOnlyScanner, ScannerLlmGateway } from "./read-only-scanner";
import { ResumableScanner } from "./resumable-scanner";
import { ScannerRepository } from "./scanner-repository";
import { ScanStepRepository } from "./scan-step";
import { DATABASE_POOL } from "../shared/database/database-tokens";
import {
  KALSHI_VENUE_CLIENT,
  LLM_EVALUATION_REPOSITORY,
  POLYMARKET_VENUE_CLIENT,
  SCAN_STEP_REPOSITORY,
  SCANNER_LLM_GATEWAY,
  SCANNER_REPOSITORY,
  SENTRY_CHECK_IN_CLIENT
} from "./scanner-tokens";
import { WorkerScanRunner } from "./worker-scan-runner";

// Phase 4 Finding #6: per-worker lease. Generated once at module load
// time and shared by ResumableScanner (stamps it on scan results) and
// AbandonedScanDetector (uses it to skip owned runs). Each worker
// process gets a unique UUID so a restarted worker does NOT inherit
// the previous process's lease — stale scans from the dead process
// are correctly flagged as abandoned.
const WORKER_ID = randomUUID();

@Module({
  providers: [
    // The Postgres pool is now provided by the shared `DatabaseModule`
    // (`DATABASE_POOL`, owned by `DatabasePoolHolder`). This module
    // injects it; it no longer owns a scanner-scoped pool or its
    // lifetime. See `src/contexts/shared/database/database.module.ts`.
    {
      provide: KALSHI_VENUE_CLIENT,
      useFactory: () => new KalshiPublicVenueClient(undefined, { concurrency: 5, retries: 3, timeoutMs: 10_000 })
    },
    {
      provide: POLYMARKET_VENUE_CLIENT,
      useFactory: () => new PolymarketPublicVenueClient(undefined, undefined, { concurrency: 8, retries: 3, timeoutMs: 10_000 })
    },
    PostgresScannerRepository,
    { provide: SCANNER_REPOSITORY, useExisting: PostgresScannerRepository },
    {
      provide: LLM_EVALUATION_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresLlmEvaluationRepository(pool),
      inject: [DATABASE_POOL]
    },
    {
      provide: SCAN_STEP_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresScanStepRepository(pool),
      inject: [DATABASE_POOL]
    },
    {
      // Phase 4: the Sentry check-in client is real when SENTRY_DSN is
      // configured, otherwise the in-process fake is used so a
      // misconfigured deploy cannot crash the worker. Both
      // implementations satisfy SentryCheckInClient.
      provide: SENTRY_CHECK_IN_CLIENT,
      useFactory: (config: AppConfig): SentryCheckInClient => {
        if (!config.sentryDsn) return new FakeSentryCheckInClient();
        return new SentryHttpCheckInClient({ dsn: config.sentryDsn });
      },
      inject: [APP_CONFIG]
    },
    {
      provide: SCANNER_LLM_GATEWAY,
      useFactory: (repository: LlmEvaluationRepository, config: AppConfig) => {
        if (!config.llmEnabled) return undefined;
        const provider = new OllamaChatLlmProvider({
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          timeoutMs: config.llmRequestTimeoutMs
        });
        // Use the built-in default pricing table. If the production
        // model is not in the table, add it to DEFAULT_PRICING in
        // llm-cost-calculator.ts or pass an override via options.
        const costCalculator = new LlmCostCalculator(DEFAULT_PRICING);
        // Trace reporter is only active when Sentry is configured.
        // Without a DSN the Sentry SDK silently drops spans/metrics.
        const traceReporter = config.sentryDsn
          ? new SentryLlmTraceReporter()
          : undefined;
        return new PersistedLlmGateway(repository, provider.evaluate.bind(provider), {
          validatorRegistry: buildScannerLlmValidatorRegistry(),
          costCalculator,
          traceReporter
        });
      },
      inject: [LLM_EVALUATION_REPOSITORY, APP_CONFIG]
    },
    // Phase 3 #6: production paper-trade simulator. Uses default target
    // notionals [5, 25, 100, executableSizeUsd] and 25 bps adverse
    // selection. Injected into ReadOnlyScanner so live scans persist
    // paper_trade_simulations rows for every emitted opportunity, which
    // /v1/opportunities/:id/paper-trades and the runbook then surface.
    // The simulator degrades to a partial-fill record on malformed input
    // and is wrapped per-opportunity in try/catch inside the scanner, so
    // it cannot fail the scan.
    { provide: PaperTradeSimulator, useFactory: () => new PaperTradeSimulator() },
    {
      provide: ReadOnlyScanner,
      useFactory: (
        kalshiClient: VenueClient,
        polymarketClient: VenueClient,
        repository: ScannerRepository,
        llmGateway: ScannerLlmGateway,
        paperTradeSimulator: PaperTradeSimulator,
        config: AppConfig
      ) =>
        new ReadOnlyScanner({
          kalshiClient,
          polymarketClient,
          repository,
          llmGateway,
          paperTradeSimulator,
          llmPromptVersion: config.scannerLlmPromptVersion,
          llmModel: config.llmModel,
          scannerLlmMaxEvaluationsPerScan: config.scannerLlmMaxEvaluationsPerScan,
          // Scan telemetry reporter is only active when Sentry is
          // configured. Without a DSN, all reporter calls are no-ops
          // (Sentry SDK drops events when not initialised).
          telemetryReporter: config.sentryDsn ? new SentryScanTelemetryReporter() : undefined
        }),
      inject: [KALSHI_VENUE_CLIENT, POLYMARKET_VENUE_CLIENT, SCANNER_REPOSITORY, SCANNER_LLM_GATEWAY, PaperTradeSimulator, APP_CONFIG]
    },
    {
      provide: ResumableScanner,
      useFactory: (
        innerScanner: ReadOnlyScanner,
        stepRepository: ScanStepRepository,
        checkInClient: SentryCheckInClient,
        config: AppConfig
      ) =>
        new ResumableScanner({
          innerScanner,
          stepRepository,
          checkInClient,
          monitorSlug: config.sentryMonitorSlug,
          workerId: WORKER_ID
        }),
      inject: [ReadOnlyScanner, SCAN_STEP_REPOSITORY, SENTRY_CHECK_IN_CLIENT, APP_CONFIG]
    },
    {
      provide: AbandonedScanDetector,
      useFactory: (repository: ScannerRepository, stepRepository: ScanStepRepository, config: AppConfig) =>
        new AbandonedScanDetector({ repository, stepRepository, abandonedAfterMs: config.scannerAbandonedAfterMs, workerId: WORKER_ID }),
      inject: [SCANNER_REPOSITORY, SCAN_STEP_REPOSITORY, APP_CONFIG]
    },
    {
      provide: WorkerScanRunner,
      useFactory: (resumableScanner: ResumableScanner, abandonedDetector: AbandonedScanDetector) =>
        new WorkerScanRunner(resumableScanner, abandonedDetector),
      inject: [ResumableScanner, AbandonedScanDetector]
    }
  ],
  exports: [WorkerScanRunner]
})
export class ScannerModule {}
