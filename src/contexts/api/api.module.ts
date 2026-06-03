import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import {
  MARKET_READ_REPOSITORY,
  MarketReadService,
  OPPORTUNITY_READ_REPOSITORY,
  OpportunityReadService,
  SCAN_RUN_READ_REPOSITORY,
  ScanRunReadService
} from "./read-models";
import { MarketsController } from "./markets.controller";
import { OpportunitiesController } from "./opportunities.controller";
import { PostgresReadRepositories } from "./postgres-read-repositories";
import { ScanRunsController } from "./scan-runs.controller";

@Module({
  controllers: [HealthController, MarketsController, OpportunitiesController, ScanRunsController],
  providers: [
    PostgresReadRepositories,
    OpportunityReadService,
    MarketReadService,
    ScanRunReadService,
    { provide: OPPORTUNITY_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: MARKET_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: SCAN_RUN_READ_REPOSITORY, useExisting: PostgresReadRepositories }
  ],
  exports: [OpportunityReadService, MarketReadService, ScanRunReadService]
})
export class ApiModule {}
