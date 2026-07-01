import type { CrossVenueOpportunity } from "../../arbitrage/domain/opportunity";

/**
 * Unified fill outcome the orchestrator works against. The two venue trading
 * clients (#77 Kalshi, #78 Polymarket) return slightly different raw result
 * shapes; the orchestrator normalises them into this single type so the
 * execution logic stays venue-agnostic.
 */
export interface LegFillResult {
  /** Venue-assigned order id; empty string when the order was rejected. */
  orderId: string;
  /** True when the leg was filled; false on rejection/timeout/failure. */
  filled: boolean;
  /** Realised fill price (0 when not filled). */
  fillPrice: number;
  /** Realised fill size (0 when not filled). */
  fillSize: number;
  /** Failure/rejection reason, if any. */
  error?: string;
}

/**
 * Minimal trading-client surface the orchestrator depends on. Both
 * `KalshiTradingClient` and `PolymarketTradingClient` satisfy this contract
 * once wrapped (see `KalshiTradingClientAdapter` / `PolymarketTradingClientAdapter`
 * below). Injecting this interface keeps the orchestrator testable without
 * real API calls and decouples it from per-venue auth/signing details.
 */
export interface TradingClient {
  placeOrder(market: string, side: string, price: number, size: number): Promise<LegFillResult>;
  cancelOrder(orderId: string): Promise<void>;
}

/**
 * The pair of clients the orchestrator needs to execute a cross-venue
 * opportunity: one per leg venue.
 */
export interface TradingClients {
  kalshi: TradingClient;
  polymarket: TradingClient;
}

/**
 * Per-leg execution record persisted in the `orders` table.
 */
export interface RecordedOrder {
  id: string;
  venue: string;
  market: string;
  side: string;
  price: string;
  size: string;
  status: string;
}

export interface RecordedFill {
  id: string;
  orderId: string;
  fillPrice: string;
  fillSize: string;
}

export interface RecordedPosition {
  id: string;
  opportunityId: string;
  kalshiOrderId: string | null;
  polyOrderId: string | null;
  status: "open" | "partial" | "exposed" | "closed";
}

/**
 * Persistence sink the orchestrator writes orders/fills/positions through.
 * Tests pass an in-memory implementation; production passes a drizzle-backed
 * implementation. The interface mirrors only the insert surface the
 * orchestrator needs.
 */
export interface ExecutionRepositories {
  orders: {
    insert(row: {
      venue: string;
      market: string;
      side: string;
      price: string;
      size: string;
      status: string;
    }): Promise<RecordedOrder> | RecordedOrder;
  };
  fills: {
    insert(row: { orderId: string; fillPrice: string; fillSize: string }): Promise<RecordedFill> | RecordedFill;
  };
  positions: {
    insert(row: {
      opportunityId: string;
      kalshiOrderId: string | null;
      polyOrderId: string | null;
      status: string;
      pnl?: string;
    }): Promise<RecordedPosition> | RecordedPosition;
  };
}

export interface ExecutionResult {
  /** Recorded position, if any. Undefined when both legs failed. */
  position?: RecordedPosition;
  /** Per-leg fill outcomes keyed by venue. */
  legs: {
    kalshi: LegFillResult;
    polymarket: LegFillResult;
  };
}

/**
 * Executes a `CrossVenueOpportunity` by submitting both legs to their
 * respective venue trading clients in parallel, with a hardcoded 30s timeout.
 *
 * Both legs are submitted via `Promise.allSettled` so one leg rejecting does
 * not short-circuit the other — we always observe both outcomes before
 * deciding the position status.
 *
 * - both fill  → position `open`
 * - one fills  → position `partial` (handed off to #80 for unwinding)
 * - none fill  → no position created
 */
export class ExecutionOrchestrator {
  /** Hardcoded 30s leg timeout. Not configurable — by design (issue #79). */
  static readonly TIMEOUT_MS = 30_000;

  constructor(private readonly repos: ExecutionRepositories) {}

  async execute(opportunity: CrossVenueOpportunity, clients: TradingClients): Promise<ExecutionResult> {
    const kalshiLeg = this.toLegSubmission(opportunity, opportunity.longLeg, "kalshi");
    const polyLeg = this.toLegSubmission(opportunity, opportunity.hedgeLeg, "polymarket");

    // `Promise.allSettled` ensures a rejection on one leg (network error,
    // venue rejection) does not short-circuit the other — both legs always
    // run to completion (or the 30s timeout) before we decide position
    // status.
    const [kalshiSettled, polySettled] = await Promise.allSettled([
      this.raceWithTimeout(clients.kalshi.placeOrder(kalshiLeg.market, kalshiLeg.side, kalshiLeg.price, kalshiLeg.size)),
      this.raceWithTimeout(clients.polymarket.placeOrder(polyLeg.market, polyLeg.side, polyLeg.price, polyLeg.size))
    ]);

    const kalshiResult = this.toLegResult(kalshiSettled);
    const polyResult = this.toLegResult(polySettled);

    // Persist both orders regardless of outcome; failed legs are recorded as
    // `failed` so the audit trail shows what was attempted.
    const kalshiOrder = await this.repos.orders.insert({
      venue: "kalshi",
      market: kalshiLeg.market,
      side: kalshiLeg.side,
      price: String(kalshiLeg.price),
      size: String(kalshiLeg.size),
      status: kalshiResult.filled ? "filled" : "failed"
    });
    const polyOrder = await this.repos.orders.insert({
      venue: "polymarket",
      market: polyLeg.market,
      side: polyLeg.side,
      price: String(polyLeg.price),
      size: String(polyLeg.size),
      status: polyResult.filled ? "filled" : "failed"
    });

    // Record fills for any leg that actually filled.
    if (kalshiResult.filled && kalshiResult.fillSize > 0) {
      await this.repos.fills.insert({
        orderId: kalshiOrder.id,
        fillPrice: String(kalshiResult.fillPrice),
        fillSize: String(kalshiResult.fillSize)
      });
    }
    if (polyResult.filled && polyResult.fillSize > 0) {
      await this.repos.fills.insert({
        orderId: polyOrder.id,
        fillPrice: String(polyResult.fillPrice),
        fillSize: String(polyResult.fillSize)
      });
    }

    const kalshiFilled = kalshiResult.filled;
    const polyFilled = polyResult.filled;

    let position: RecordedPosition | undefined;
    if (kalshiFilled && polyFilled) {
      position = await this.repos.positions.insert({
        opportunityId: opportunity.id,
        kalshiOrderId: kalshiOrder.id,
        polyOrderId: polyOrder.id,
        status: "open"
      });
    } else if (kalshiFilled || polyFilled) {
      position = await this.repos.positions.insert({
        opportunityId: opportunity.id,
        kalshiOrderId: kalshiFilled ? kalshiOrder.id : null,
        polyOrderId: polyFilled ? polyOrder.id : null,
        status: "partial"
      });
    }
    // both failed → no position recorded.

    return { position, legs: { kalshi: kalshiResult, polymarket: polyResult } };
  }

  private toLegSubmission(
    opportunity: CrossVenueOpportunity,
    leg: CrossVenueOpportunity["longLeg"],
    venue: "kalshi" | "polymarket"
  ): { market: string; side: string; price: number; size: number } {
    const executableSize = opportunity.executableSizeUsd > 0 ? opportunity.executableSizeUsd : opportunity.maxTradableUsd;
    return {
      market: leg.marketId,
      side: leg.side,
      price: leg.askPrice,
      size: executableSize
    };
  }

  private async raceWithTimeout(p: Promise<LegFillResult>): Promise<LegFillResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LegFillResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ orderId: "", filled: false, fillPrice: 0, fillSize: 0, error: "timeout" }),
        ExecutionOrchestrator.TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Normalises a `Promise.allSettled` outcome into a `LegFillResult`.
   * A rejected promise (thrown error from the trading client) becomes a
   * non-filled leg carrying the error message — the orchestrator treats it
   * the same as a venue-level rejection.
   */
  private toLegResult(settled: PromiseSettledResult<LegFillResult>): LegFillResult {
    if (settled.status === "fulfilled") {
      return settled.value;
    }
    const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    return { orderId: "", filled: false, fillPrice: 0, fillSize: 0, error: reason };
  }
}