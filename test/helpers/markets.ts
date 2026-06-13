import { StaticVenueClient } from "../../src/contexts/venues/application/static-venue-client";
import { VenueClient, VenueMarketSnapshot } from "../../src/contexts/venues/domain/venue-market";

export const DEFAULT_RAW_RESOLUTION_TEXT = "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z";

export function venueMarketSnapshot(
  capturedAt: string,
  venue: "kalshi" | "polymarket",
  id: string,
  title: string,
  rawResolutionText = DEFAULT_RAW_RESOLUTION_TEXT
): VenueMarketSnapshot {
  return {
    venue,
    venueMarketId: id,
    title,
    rawResolutionText,
    rawPayload: { id, title },
    capturedAt
  };
}

export function kalshiPolymarketPair(capturedAt: string): { kalshiClient: VenueClient; polymarketClient: VenueClient } {
  return {
    kalshiClient: new StaticVenueClient({
      markets: [venueMarketSnapshot(capturedAt, "kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
      books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
    }),
    polymarketClient: new StaticVenueClient({
      markets: [venueMarketSnapshot(capturedAt, "polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
      books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
    })
  };
}
