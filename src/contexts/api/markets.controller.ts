import { Controller, Get, Inject, Query } from "@nestjs/common";
import { MarketReadService } from "./read-models";

@Controller("v1/markets")
export class MarketsController {
  constructor(@Inject(MarketReadService) private readonly markets: MarketReadService) {}

  @Get()
  list(
    @Query("offset") offset?: string,
    @Query("limit") limit?: string
  ) {
    const pagination = {
      offset: offset ? Math.max(0, parseInt(offset, 10)) : 0,
      limit: limit ? Math.min(500, Math.max(1, parseInt(limit, 10))) : 50
    };

    return this.markets.listMarkets({ pagination });
  }
}
