import { MarketBook } from "../../arbitrage/domain/opportunity";
import { VenueClient, VenueMarketSnapshot } from "../domain/venue-market";

export interface StaticVenueClientData {
  markets: VenueMarketSnapshot[];
  books: MarketBook[];
}

export class StaticVenueClient implements VenueClient {
  constructor(private readonly data: StaticVenueClientData) {}

  listMarkets(): Promise<VenueMarketSnapshot[]> {
    return Promise.resolve(this.data.markets);
  }

  listOrderbooks(markets: VenueMarketSnapshot[]): Promise<MarketBook[]> {
    const marketIds = new Set(markets.map((market) => market.venueMarketId));
    return Promise.resolve(this.data.books.filter((book) => marketIds.has(book.marketId)));
  }
}
