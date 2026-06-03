import { Controller, Get } from "@nestjs/common";
import { MarketReadService } from "./read-models";

@Controller("v1/markets")
export class MarketsController {
  constructor(private readonly markets: MarketReadService) {}

  @Get()
  list() {
    return this.markets.listMarkets();
  }
}
