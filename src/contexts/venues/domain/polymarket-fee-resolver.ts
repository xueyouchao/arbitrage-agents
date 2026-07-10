import { ContractSide, MarketBook } from "../../arbitrage/domain/opportunity";

/**
 * Resolve an effective flat fee rate for a Polymarket orderbook using the
 * market's raw fee schedule, if present.
 *
 * Polymarket crypto markets expose `feeSchedule.rate` in the market metadata.
 * The platform's fee formula for an order of size C at share price p is:
 *
 *   fee = C * rate * p * (1 - p)
 *
 * To compare this with the calculator's flat-rate-per-dollar-of-payoff model,
 * we convert it to an effective flat rate on the **payoff** dollar:
 *
 *   effectiveRate = rate * (1 - p)
 *
 * where p is the ask price for the side we intend to fill. This is the
 * conversion used in Polymarket's documentation for taker fee estimation.
 *
 * If the payload does not contain a valid crypto fee schedule, we return
 * undefined so the caller can fall back to configured rates.
 */
export function resolvePolymarketFeeRate(
  book: MarketBook,
  side: ContractSide
): number | undefined {
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
  if (!rate || rate <= 0 || rate >= 1) return undefined;

  const sidePrice = side === "YES" ? book.yesAsk : book.noAsk;
  if (!Number.isFinite(sidePrice) || sidePrice <= 0 || sidePrice >= 1) {
    return undefined;
  }

  return rate * (1 - sidePrice);
}
