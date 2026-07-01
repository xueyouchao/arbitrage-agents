import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import {
  MARKET_READ_REPOSITORY,
  MarketReadService,
  OPPORTUNITY_READ_REPOSITORY,
  OpportunityReadService,
  PAPER_TRADE_SIMULATION_READ_REPOSITORY,
  PaperTradeSimulationReadService,
  POSITION_READ_REPOSITORY,
  PositionReadService,
  SCAN_RUN_READ_REPOSITORY,
  ScanRunReadService
} from "./read-models";
import { MarketsController } from "./markets.controller";
import { OpportunitiesController } from "./opportunities.controller";
import { PaperTradeSimulationsController } from "./paper-trade-simulations.controller";
import { PositionsController } from "./positions.controller";
import { PostgresReadRepositories } from "./postgres-read-repositories";
import { ScanRunsController } from "./scan-runs.controller";

@Module({
  controllers: [
    HealthController,
    MarketsController,
    OpportunitiesController,
    ScanRunsController,
    PaperTradeSimulationsController,
    PositionsController
  ],
  providers: [
    PostgresReadRepositories,
    OpportunityReadService,
    MarketReadService,
    ScanRunReadService,
    PaperTradeSimulationReadService,
    PositionReadService,
    { provide: OPPORTUNITY_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: MARKET_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: SCAN_RUN_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: PAPER_TRADE_SIMULATION_READ_REPOSITORY, useExisting: PostgresReadRepositories },
    { provide: POSITION_READ_REPOSITORY, useExisting: PostgresReadRepositories }
  ],
  exports: [OpportunityReadService, MarketReadService, ScanRunReadService, PaperTradeSimulationReadService, PositionReadService]
})
export class ApiModule {}
