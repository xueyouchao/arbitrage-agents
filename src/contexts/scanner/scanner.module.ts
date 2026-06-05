import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../venues/infrastructure/http-venue-clients";
import { VenueClient } from "../venues/domain/venue-market";
import { PostgresScannerRepository } from "./postgres-scanner-repository";
import { ReadOnlyScanner } from "./read-only-scanner";
import { ScannerRepository } from "./scanner-repository";
import { KALSHI_VENUE_CLIENT, POLYMARKET_VENUE_CLIENT, SCANNER_DB_POOL, SCANNER_REPOSITORY } from "./scanner-tokens";
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
      provide: ReadOnlyScanner,
      useFactory: (kalshiClient: VenueClient, polymarketClient: VenueClient, repository: ScannerRepository) =>
        new ReadOnlyScanner({ kalshiClient, polymarketClient, repository }),
      inject: [KALSHI_VENUE_CLIENT, POLYMARKET_VENUE_CLIENT, SCANNER_REPOSITORY]
    },
    WorkerScanRunner
  ],
  exports: [WorkerScanRunner]
})
export class ScannerModule {}
