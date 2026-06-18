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
    const parsedOffset = Number(offset);
    const parsedLimit = Number(limit);
    
    const pagination = {
      offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.min(10000, Math.floor(parsedOffset)) : 0,
      limit: Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(500, Math.floor(parsedLimit)) : 50
    };

    return this.markets.listMarkets({ pagination });
  }
}
