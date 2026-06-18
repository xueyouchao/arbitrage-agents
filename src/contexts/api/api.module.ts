import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import {
  MARKET_READ_REPOSITORY,
  MarketReadService,
  OPPORTUNITY_READ_REPOSITORY,
  OpportunityReadService,
  PAPER_TRADE_SIMULATION_READ_REPOSITORY,
  PaperTradeSimulationReadService,
  SCAN_RUN_READ_REPOSITORY,
  ScanRunReadService
} from "./read-models";
import { MarketsController } from "./markets.controller";
import { OpportunitiesController } from "./opportunities.controller";
import { PaperTradeSimulationsController } from "./paper-trade-simulations.controller";
import { PostgresReadRepositories } from "./postgres-read-repositories";
import { ScanRunsController } from "./scan-runs.controller";

@Module({
  controllers: [HealthController, MarketsController, OpportunitiesController, ScanRunsController, PaperTradeSimulationsController],
  providers: [
    PostgresReadRepositories,
    OpportunityReadService,
    MarketReadService,
    ScanRunReadService,
    PaperTradeSimulationReadService,
    { provide: OPPORTUNITY_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: MARKET_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: SCAN_RUN_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: PAPER_TRADE_SIMULATION_READ_REPOSITORY, useExisting: PostgresReadRepositories }
  ],
  exports: [OpportunityReadService, MarketReadService, ScanRunReadService, PaperTradeSimulationReadService]
})
export class ApiModule {}
