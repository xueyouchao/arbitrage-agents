import { Controller, Get, Inject } from "@nestjs/common";
import { MarketReadService } from "./read-models";

@Controller("v1/markets")
export class MarketsController {
  constructor(@Inject(MarketReadService) private readonly markets: MarketReadService) {}

  @Get()
  list() {
    return this.markets.listMarkets();
  }
}
