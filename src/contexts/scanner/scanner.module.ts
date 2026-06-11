import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { LlmEvaluationRepository } from "../llm/application/llm-evaluation";
import { PersistedLlmGateway } from "../llm/application/persisted-llm-gateway";
import { OllamaChatLlmProvider } from "../llm/infrastructure/ollama-chat-llm-provider";
import { PostgresLlmEvaluationRepository } from "../llm/infrastructure/postgres-llm-evaluation-repository";
import { buildScannerLlmValidatorRegistry } from "../llm/scanner-llm-validators";
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
      provide: SCANNER_LLM_GATEWAY,
      useFactory: (repository: LlmEvaluationRepository, config: AppConfig) => {
        if (!config.llmEnabled) return undefined;
        const provider = new OllamaChatLlmProvider({
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          timeoutMs: config.llmRequestTimeoutMs
        });
        // Issue #14: register the scanner-owned validators with the
        // gateway so scanner domain churn does not leak into the generic
        // LLM persistence module. The same registry also powers the
        // single source of truth for prompt-side and validator-side
        // schemas (issue #15).
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
    WorkerScanRunner
  ],
  exports: [WorkerScanRunner]
})
export class ScannerModule {}
