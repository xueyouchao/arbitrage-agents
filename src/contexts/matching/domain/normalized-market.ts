export const VENUES = ["kalshi", "polymarket"] as const;
export type Venue = (typeof VENUES)[number];
export type Topic = "crypto" | "macro" | "sports" | "politics" | "current_events";
export type EventType =
  | "price_above"
  | "price_below"
  | "fed_rate_decision"
  | "cpi_range"
  | "winner"
  | "total"
  | "nomination"
  | "yes_no";
// Exported for callers that want the literal union of supported crypto assets.
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
  // Asset is a crypto ticker ("BTC"/"ETH") for crypto markets, or a normalized
  // subject string for sports, politics, and current-events markets. Kept as a
  // plain string so the rest of the matching pipeline can bucket by it without
  // needing a separate union that collapses to string anyway.
  asset?: string;
  threshold?: number;
  operator?: MarketOperator;
  deadline?: string;
  timezone?: string;
  resolutionSource?: string;
  payoffType: PayoffType;
  ambiguityFlags: string[];
  confidence: number;
}
