import { KalshiTradingClient } from "../../venues/infrastructure/kalshi-trading-client";
import type { LegFillResult, TradingClient } from "../application/execution-orchestrator";

/**
 * Adapts the Kalshi trading client (#77) to the venue-agnostic
 * `TradingClient` interface the `ExecutionOrchestrator` consumes.
 *
 * Kalshi's `placeOrder` returns the shared `OrderResult`
 * ({ orderId, venue, status, filledSize, avgFillPrice }). We map a Kalshi "matched"
 * status (or any non-empty filledSize) to `filled: true` so the orchestrator
 * can treat both venues uniformly.
 */
export class KalshiTradingClientAdapter implements TradingClient {
  constructor(private readonly client: KalshiTradingClient) {}

  async placeOrder(market: string, side: string, price: number, size: number, signal?: AbortSignal): Promise<LegFillResult> {
    try {
      const result = await this.client.placeOrder(
        market,
        side === "YES" ? "yes" : "no",
        price,
        size
      );
      const filled = (result.filledSize ?? 0) > 0 || /match|fill/i.test(result.status);
      return {
        orderId: result.orderId,
        filled,
        fillPrice: result.avgFillPrice ?? 0,
        fillSize: result.filledSize ?? 0
      };
    } catch (error) {
      return {
        orderId: "",
        filled: false,
        fillPrice: 0,
        fillSize: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    return this.client.cancelOrder(orderId);
  }
}