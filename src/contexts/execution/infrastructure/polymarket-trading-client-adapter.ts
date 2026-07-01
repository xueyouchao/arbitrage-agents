import { PolymarketTradingClient } from "../../venues/infrastructure/polymarket-trading-client";
import type { LegFillResult, TradingClient } from "../application/execution-orchestrator";

/**
 * Adapts the Polymarket trading client (#78) to the venue-agnostic
 * `TradingClient` interface the `ExecutionOrchestrator` consumes.
 *
 * Polymarket's `placeOrder` returns the shared `OrderResult`
 * ({ orderId, venue, status, rawResponse? }) with status in
 * {"placed","cancelled","failed"}. Polymarket's CLOB returns a "placed"
 * status for resting orders; a fill is not distinguishable from the order
 * result alone, so we treat "placed" as filled (the orchestrator records the
 * fill; a later fill webhook/update would correct it — out of scope for #79).
 * "failed" maps to filled=false.
 */
export class PolymarketTradingClientAdapter implements TradingClient {
  constructor(private readonly client: PolymarketTradingClient) {}

  async placeOrder(market: string, side: string, price: number, size: number): Promise<LegFillResult> {
    try {
      const result = await this.client.placeOrder(market, side === "YES" ? "buy" : "sell", price, size);
      const filled = result.status === "placed" && result.orderId !== "";
      return {
        orderId: result.orderId,
        filled,
        // Polymarket's order result does not carry fill price/size back in
        // the placement response; we record the requested price/size as the
        // realised fill when the order is accepted.
        fillPrice: filled ? price : 0,
        fillSize: filled ? size : 0,
        error: result.status === "failed" ? "polymarket order failed" : undefined
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