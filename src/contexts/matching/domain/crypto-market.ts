import { NormalizedMarket } from "./normalized-market";

/**
 * A price-level crypto market settles against a numeric asset threshold
 * (e.g. "BTC will close above $62,000"). These markets are matched across
 * venues with a deliberately relaxed threshold and deadline tolerance
 * because index providers and daily settlement times differ.
 *
 * The check uses a minimal structural shape so it can be reused by callers
 * that only hold a subset of NormalizedMarket fields.
 */
export function isCryptoPriceLevel(market: { topic: string; eventType: string }): boolean {
  return (
    market.topic === "crypto" &&
    (market.eventType === "price_above" || market.eventType === "price_below")
  );
}

/**
 * True when both markets are crypto price-level markets. Used for
 * cross-venue candidate generation and equivalence classification.
 */
export function bothCryptoPriceLevels(
  left: { topic: string; eventType: string },
  right: { topic: string; eventType: string }
): boolean {
  return isCryptoPriceLevel(left) && isCryptoPriceLevel(right);
}
