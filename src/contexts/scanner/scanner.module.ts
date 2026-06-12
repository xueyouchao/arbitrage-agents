import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { LlmEvaluationRepository } from "../llm/application/llm-evaluation";
import { PersistedLlmGateway } from "../llm/application/persisted-llm-gateway";
import { OllamaChatLlmProvider } from "../llm/infrastructure/ollama-chat-llm-provider";
import { PostgresLlmEvaluationRepository } from "../llm/infrastructure/postgres-llm-evaluation-repository";
import { buildScannerLlmValidatorRegistry } from "../llm/scanner-llm-validators";
import { FakeSentryCheckInClient, SentryCheckInClient, SentryHttpCheckInClient } from "../observability/sentry-check-in-client";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../venues/infrastructure/http-venue-clients";
import { VenueClient } from "../venues/domain/venue-market";
import { AbandonedScanDetector } from "./abandoned-scan-detector";
import { PostgresScanStepRepository } from "./postgres-scan-step-repository";
import { PostgresScannerRepository } from "./postgres-scanner-repository";
import { ReadOnlyScanner, ScannerLlmGateway } from "./read-only-scanner";
import { ResumableScanner } from "./resumable-scanner";
import { ScannerRepository } from "./scanner-repository";
import { ScanStepRepository } from "./scan-step";
import {
  KALSHI_VENUE_CLIENT,
  LLM_EVALUATION_REPOSITORY,
  POLYMARKET_VENUE_CLIENT,
  SCAN_STEP_REPOSITORY,
  SCANNER_DB_POOL,
  SCANNER_LLM_GATEWAY,
  SCANNER_REPOSITORY,
  SENTRY_CHECK_IN_CLIENT
} from "./scanner-tokens";
import { WorkerScanRunner } from "./worker-scan-runner";

@Module({
  providers: [
    {
      provide: SCANNER_DB_POOL,
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl }),
      inject: [APP_CONFIG]
    },
    { provide: KALSHI_VENUE_CLIENT, useFactory: () => new KalshiPublicVenueClient() },
    { provide: POLYMARKET_VENUE_CLIENT, useFactory: () => new PolymarketPublicVenueClient() },
    PostgresScannerRepository,
    { provide: SCANNER_REPOSITORY, useExisting: PostgresScannerRepository },
    {
      provide: LLM_EVALUATION_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresLlmEvaluationRepository(pool),
      inject: [SCANNER_DB_POOL]
    },
    {
      provide: SCAN_STEP_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresScanStepRepository(pool),
      inject: [SCANNER_DB_POOL]
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
        return new PersistedLlmGateway(repository, provider.evaluate.bind(provider), {
          validatorRegistry: buildScannerLlmValidatorRegistry()
        });
      },
      inject: [LLM_EVALUATION_REPOSITORY, APP_CONFIG]
    },
    {
      provide: ReadOnlyScanner,
      useFactory: (
        kalshiClient: VenueClient,
        polymarketClient: VenueClient,
        repository: ScannerRepository,
        llmGateway: ScannerLlmGateway,
        config: AppConfig
      ) =>
        new ReadOnlyScanner({
          kalshiClient,
          polymarketClient,
          repository,
          llmGateway,
          llmPromptVersion: config.scannerLlmPromptVersion,
          llmModel: config.llmModel,
          scannerLlmMaxEvaluationsPerScan: config.scannerLlmMaxEvaluationsPerScan
        }),
      inject: [KALSHI_VENUE_CLIENT, POLYMARKET_VENUE_CLIENT, SCANNER_REPOSITORY, SCANNER_LLM_GATEWAY, APP_CONFIG]
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
          monitorSlug: config.sentryMonitorSlug
        }),
      inject: [ReadOnlyScanner, SCAN_STEP_REPOSITORY, SENTRY_CHECK_IN_CLIENT, APP_CONFIG]
    },
    {
      provide: AbandonedScanDetector,
      useFactory: (repository: ScannerRepository, stepRepository: ScanStepRepository, config: AppConfig) =>
        new AbandonedScanDetector({ repository, stepRepository, abandonedAfterMs: config.scannerAbandonedAfterMs }),
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
