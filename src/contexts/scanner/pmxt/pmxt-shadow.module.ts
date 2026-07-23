import { Module } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { AppConfig } from "../../../config/app-config";
import { APP_CONFIG } from "../../../config/config.module";
import { DATABASE_POOL } from "../../shared/database/database-tokens";
import {
  createPmxtHostedClient,
  PmxtHostedClientOptions,
  PmxtHostedReadOnlyClient,
} from "../../venues/infrastructure/pmxt/pmxt-hosted-client-factory";
import {
  createPmxtRouterClient,
  PmxtRouterClient,
  PmxtRouterClientOptions,
} from "../../venues/infrastructure/pmxt/pmxt-router-client-factory";
import { PMXT_SHADOW_RUNNER } from "../scanner-tokens";
import { PostgresPmxtAuthoritativeMarketSnapshotRepository } from "./postgres-pmxt-authoritative-market-snapshot-repository";
import { PostgresPmxtShadowLeaseRepository } from "./postgres-pmxt-shadow-lease-repository";
import { PostgresPmxtShadowTrackRepository } from "./postgres-pmxt-shadow-track-repository";
import { PmxtProductionShadowRun } from "./pmxt-production-shadow-run";
import { PmxtShadowRateLimiter } from "./pmxt-shadow-rate-limiter";
import { PmxtShadowRunner } from "./pmxt-shadow-runner";

interface PmxtProductionFactoryDeps {
  hostedFactory(options: PmxtHostedClientOptions): Promise<PmxtHostedReadOnlyClient>;
  routerFactory(options: PmxtRouterClientOptions): PmxtRouterClient | undefined;
}

const defaultFactories: PmxtProductionFactoryDeps = {
  hostedFactory: createPmxtHostedClient,
  routerFactory: createPmxtRouterClient,
};

export async function createPmxtProductionRunner(
  config: AppConfig,
  leaseRepository: PostgresPmxtShadowLeaseRepository,
  authoritativeRepository: PostgresPmxtAuthoritativeMarketSnapshotRepository,
  trackRepository: PostgresPmxtShadowTrackRepository,
  factories: PmxtProductionFactoryDeps = defaultFactories
): Promise<PmxtShadowRunner | undefined> {
  if (!config.pmxtShadowEnabled) return undefined;

  const hostedOptions = {
    apiKey: config.pmxtApiKey,
    hostedBaseUrl: config.pmxtHostedBaseUrl,
    pmxtShadowEnabled: true,
    // Router-only still needs exact series catalogs to build anchors.
    pmxtShadowReadsEnabled: true,
    autoStartServer: false,
  } as const;
  const [kalshiCatalogClient, polymarketCatalogClient] = await Promise.all([
    factories.hostedFactory({ ...hostedOptions, venue: "kalshi" }),
    factories.hostedFactory({ ...hostedOptions, venue: "polymarket" }),
  ]);
  const routerClient = factories.routerFactory({
    enabled: config.pmxtShadowRouterEnabled,
    apiKey: config.pmxtApiKey,
    hostedBaseUrl: config.pmxtHostedBaseUrl,
  });
  const productionRun = new PmxtProductionShadowRun({
    authoritativeRepository,
    kalshiCatalogClient,
    polymarketCatalogClient,
    routerClient,
    repository: trackRepository,
    kalshiSeries: config.kalshiSeriesTicker,
    polymarketSeries: config.polymarketSeriesSlug,
    readsEnabled: config.pmxtShadowReadsEnabled,
    routerEnabled: config.pmxtShadowRouterEnabled,
  });
  const rateLimiter = new PmxtShadowRateLimiter({
    requestsPerMinute: config.pmxtShadowRequestsPerMinute,
    maxConcurrency: config.pmxtShadowMaxConcurrency,
    maxRequestsPerRun: config.pmxtShadowMaxRequestsPerRun ?? 0,
    defaultRetryAfterMs: config.pmxtShadowMaxQueueWaitMs,
  });
  return new PmxtShadowRunner({
    config,
    leaseRepository,
    rateLimiter,
    productionRun,
    workerId: randomUUID(),
  });
}

@Module({
  providers: [
    PostgresPmxtShadowLeaseRepository,
    PostgresPmxtAuthoritativeMarketSnapshotRepository,
    {
      provide: PostgresPmxtShadowTrackRepository,
      useFactory: (pool: Pool, config: AppConfig) =>
        new PostgresPmxtShadowTrackRepository(pool, config.pmxtShadowRawRetentionDays),
      inject: [DATABASE_POOL, APP_CONFIG],
    },
    {
      provide: PMXT_SHADOW_RUNNER,
      useFactory: createPmxtProductionRunner,
      inject: [
        APP_CONFIG,
        PostgresPmxtShadowLeaseRepository,
        PostgresPmxtAuthoritativeMarketSnapshotRepository,
        PostgresPmxtShadowTrackRepository,
      ],
    },
  ],
  exports: [PMXT_SHADOW_RUNNER],
})
export class PmxtShadowModule {}
