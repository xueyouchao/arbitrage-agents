import { ContractSide, MarketBook } from "../../arbitrage/domain/opportunity";

/**
 * Conservative default Polymarket crypto fee coefficient (7% at-the-money) used
 * when neither the configured fee model nor the market payload provides a
 * coefficient. Exported so tests and consumers can reference the same value.
 */
export const DEFAULT_POLYMARKET_CRYPTO_FEE_COEFFICIENT = 0.07;

/**
 * Resolve the raw probability-weighted fee coefficient for a Polymarket
 * orderbook using the market's raw fee schedule, if present.
 *
 * Polymarket crypto markets expose `feeSchedule.rate` in the market metadata.
 * The platform's fee formula for an order of size C at share price p is:
 *
 *   fee = C * rate * p * (1 - p)
 *
 * The `rate` field is the dimensionless coefficient (not a flat rate). When the
 * caller needs the effective flat rate on the **payoff** dollar, multiply by
 * `(1 - p)`.
 *
 * If the payload does not contain a valid crypto fee schedule, we return
 * undefined so the caller can fall back to a conservative default coefficient.
 */
export function resolvePolymarketFeeCoefficient(book: MarketBook): number | undefined {
  if (book.venue !== "polymarket") return undefined;

  const raw = book.rawPayload;
  if (!raw || typeof raw !== "object") return undefined;

  // Polymarket orderbook payloads wrap the market metadata under `market`
  // alongside the YES/NO books. Fall back to the top-level payload for tests
  // and backwards compatibility.
  const marketPayload =
    "market" in raw ? (raw.market as Record<string, unknown>) : raw;

  const feeSchedule = marketPayload?.feeSchedule as
    | Record<string, unknown>
    | undefined;
  const rate =
    typeof feeSchedule?.rate === "number" ? feeSchedule.rate : undefined;
  // Reject missing, NaN, and non-finite rates. The coefficient must be a real
  // number in the open interval (0, 1).
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0 || rate >= 1) {
    return undefined;
  }

  return rate;
}

/**
 * Resolve an effective flat fee rate for a Polymarket orderbook using the
 * market's raw fee schedule, if present.
 *
 * This is kept for backwards compatibility with callers that expect a flat
 * rate. New probability-weighted consumers should prefer the coefficient above
 * and compute `rate * price * (1 - price)` directly.
 */
export function resolvePolymarketFeeRate(
  book: MarketBook,
  side: ContractSide
): number | undefined {
  const coefficient = resolvePolymarketFeeCoefficient(book);
  if (coefficient === undefined) return undefined;

  const sidePrice = side === "YES" ? book.yesAsk : book.noAsk;
  if (!Number.isFinite(sidePrice) || sidePrice <= 0 || sidePrice >= 1) {
    return undefined;
  }

  return coefficient * (1 - sidePrice);
}
