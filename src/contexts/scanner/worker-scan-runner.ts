import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { APP_CONFIG } from "../../config/config.module";
import { AppConfig } from "../../config/app-config";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../venues/application/http-venue-clients";
import { ReadOnlyScanner } from "./read-only-scanner";
import { PostgresScannerRepository } from "./postgres-scanner-repository";

@Injectable()
export class WorkerScanRunner implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
  }

  async runOnce(): Promise<void> {
    const scanner = new ReadOnlyScanner({
      kalshiClient: new KalshiPublicVenueClient(),
      polymarketClient: new PolymarketPublicVenueClient(),
      repository: new PostgresScannerRepository(this.pool)
    });

    await scanner.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
