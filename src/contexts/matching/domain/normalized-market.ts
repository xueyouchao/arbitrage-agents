export type Venue = "kalshi" | "polymarket";
export type Topic = "crypto" | "macro";
export type EventType = "price_above" | "price_below" | "fed_rate_decision" | "cpi_range";
export type CryptoAsset = "BTC" | "ETH";
export type MarketOperator = ">" | ">=" | "<" | "<=" | "=" | "between";
export type PayoffType = "at_time" | "any_time_before" | "range" | "settlement_value";

export interface NormalizedMarket {
  id: string;
  venue: Venue;
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  topic: Topic;
  eventType: EventType;
  asset?: CryptoAsset;
  threshold?: number;
  operator?: MarketOperator;
  deadline?: string;
  timezone?: string;
  resolutionSource?: string;
  payoffType: PayoffType;
  ambiguityFlags: string[];
  confidence: number;
}
