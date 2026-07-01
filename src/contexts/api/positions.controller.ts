import { Controller, Get, Inject } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/app-config";
import { PositionReadService } from "./read-models";

/**
 * `GET /v1/positions` — dashboard endpoint for open positions with P&L and
 * capital utilization (issue #81). Returns a JSON object with a `positions`
 * array and a `capitalUtilization` summary.
 */
@Controller("v1/positions")
export class PositionsController {
  constructor(
    @Inject(PositionReadService) private readonly positions: PositionReadService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  @Get()
  async list() {
    const [positions, capitalUtilization] = await Promise.all([
      this.positions.listOpenPositions(),
      this.positions.getCapitalUtilization(this.config.maxCapitalDeployedUsd)
    ]);

    return { positions, capitalUtilization };
  }
}