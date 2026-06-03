import { MarketBook } from "../../arbitrage/domain/opportunity";
import { Venue } from "../../matching/domain/normalized-market";

export interface VenueMarketSnapshot {
  venue: Venue;
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  rawPayload: Record<string, unknown>;
  capturedAt: string;
}

export interface VenueClient {
  listMarkets(): Promise<VenueMarketSnapshot[]>;
  listOrderbooks(markets: VenueMarketSnapshot[]): Promise<MarketBook[]>;
}
