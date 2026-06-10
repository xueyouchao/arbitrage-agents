import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { LlmEvaluationRepository } from "../llm/application/llm-evaluation";
import { noopLlmProvider } from "../llm/application/noop-llm-provider";
import { PersistedLlmGateway } from "../llm/application/persisted-llm-gateway";
import { PostgresLlmEvaluationRepository } from "../llm/infrastructure/postgres-llm-evaluation-repository";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../venues/infrastructure/http-venue-clients";
import { VenueClient } from "../venues/domain/venue-market";
import { PostgresScannerRepository } from "./postgres-scanner-repository";
import { ReadOnlyScanner, ScannerLlmGateway } from "./read-only-scanner";
import { ScannerRepository } from "./scanner-repository";
import {
  KALSHI_VENUE_CLIENT,
  LLM_EVALUATION_REPOSITORY,
  POLYMARKET_VENUE_CLIENT,
  SCANNER_DB_POOL,
  SCANNER_LLM_GATEWAY,
  SCANNER_REPOSITORY
} from "./scanner-tokens";
import { WorkerScanRunner } from "./worker-scan-runner";

@Module({
  providers: [
    {
      provide: SCANNER_DB_POOL,
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl }),
      inject: [APP_CONFIG]
    },
    {
      provide: KALSHI_VENUE_CLIENT,
      useFactory: (config: AppConfig) => new KalshiPublicVenueClient(undefined, venueHttpOptions(config)),
      inject: [APP_CONFIG]
    },
    {
      provide: POLYMARKET_VENUE_CLIENT,
      useFactory: (config: AppConfig) => new PolymarketPublicVenueClient(undefined, undefined, venueHttpOptions(config)),
      inject: [APP_CONFIG]
    },
    PostgresScannerRepository,
    { provide: SCANNER_REPOSITORY, useExisting: PostgresScannerRepository },
    {
      provide: LLM_EVALUATION_REPOSITORY,
      useFactory: (pool: Pool) => new PostgresLlmEvaluationRepository(pool),
      inject: [SCANNER_DB_POOL]
    },
    {
      provide: SCANNER_LLM_GATEWAY,
      useFactory: (repository: LlmEvaluationRepository) => new PersistedLlmGateway(repository, noopLlmProvider),
      inject: [LLM_EVALUATION_REPOSITORY]
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
          llmModel: config.llmModel
        }),
      inject: [KALSHI_VENUE_CLIENT, POLYMARKET_VENUE_CLIENT, SCANNER_REPOSITORY, SCANNER_LLM_GATEWAY, APP_CONFIG]
    },
    WorkerScanRunner
  ],
  exports: [WorkerScanRunner]
})
export class ScannerModule {}

function venueHttpOptions(config: AppConfig) {
  return {
    timeoutMs: config.venueHttpTimeoutMs,
    retries: config.venueHttpRetries,
    retryDelayMs: config.venueHttpRetryDelayMs,
    verbose: config.venueHttpVerbose
  };
}
