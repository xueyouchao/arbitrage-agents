/**
 * Shared trading-domain types used by venue trading clients (Polymarket,
 * Kalshi, etc.). Issue #78 defines these here so the parallel #77
 * (Kalshi) trading client can import the same `OrderResult` type.
 */

export type OrderSide = "buy" | "sell";

export type OrderStatus = "placed" | "cancelled" | "failed";

export interface OrderResult {
  orderId: string;
  venue: string;
  status: OrderStatus;
  /** Raw exchange response body, kept for debugging/audit. */
  rawResponse?: unknown;
}

/**
 * Abstracts the EOA wallet signing step so the trading client is testable
 * without ethers.js (which is not yet a dependency). The production
 * implementation will wrap an ethers.js Wallet; until then, a mock
 * signer is injected via the client constructor.
 */
export interface OrderSigner {
  /**
   * Signs a CLOB order payload and returns an Ethereum 65-byte signature
   * string (e.g. "0x...").
   */
  signOrder(payload: Record<string, unknown>): Promise<string>;
}