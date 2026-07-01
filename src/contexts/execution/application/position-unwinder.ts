import type { TradingClient, TradingClients, RecordedPosition } from "./execution-orchestrator";
import type { ContractSide } from "../../arbitrage/domain/opportunity";

/**
 * Describes the filled leg of a `partial` position so the unwinder can place
 * the reverse order on the correct venue/market/side without re-deriving it
 * from the position row (which only stores the order id, not the leg
 * parameters).
 */
export interface FilledLegDescriptor {
  venue: "kalshi" | "polymarket";
  market: string;
  /** Original side of the filled leg (YES or NO). */
  side: ContractSide;
  /** Original fill price of the filled leg. */
  price: number;
  /** Original fill size of the filled leg. */
  size: number;
}

/**
 * Persistence surface the unwinder needs. `positions.update` flips a
 * partial position to `closed` or `exposed`; `alerts.insert` persists a
 * naked-position alert when an unwind fails. Mirrors the insert surface of
 * `ExecutionRepositories` from #79 so production can back this with the same
 * drizzle connection.
 */
export interface UnwinderRepositories {
  positions: {
    update(id: string, row: { status: string; pnl?: string }): Promise<RecordedPosition> | RecordedPosition;
  };
  alerts: {
    insert(row: { opportunityId: string; channel: string; payload: Record<string, unknown> }): Promise<void> | void;
  };
}

/**
 * Options for the unwinder. `waitMs` is the pre-unwind delay (hardcoded to
 * 30_000ms in production, injectable as 0 in tests).
 */
export interface UnwinderOptions {
  waitMs: number;
}

export const UNWIND_ALERT_CHANNEL = "unwind-exposed";

/**
 * Issue #80: unwinds a `partial` position (one leg filled, the other failed)
 * by placing a reverse order on the filled leg's venue after a 30s wait.
 *
 * - Both legs fill  → position `open` (handled by `ExecutionOrchestrator`).
 * - One leg fills   → position `partial` → this class attempts to unwind.
 *
 * The unwind places a reverse order: YES → NO, NO → YES, at the complement
 * price (1 − fillPrice) for the same size. If the reverse fills, the
 * position is marked `closed` and the realised P&L recorded. If it fails,
 * the position is marked `exposed` (naked) and an alert is persisted to the
 * `alerts` table.
 *
 * The 30s wait is hardcoded in production via `UNWIND_WAIT_MS` but injectable
 * through the constructor so tests pass 0ms.
 */
export class PositionUnwinder {
  /** Hardcoded 30s pre-unwind wait. Not configurable — by design (issue #80). */
  static readonly UNWIND_WAIT_MS = 30_000;

  private readonly waitMs: number;

  constructor(
    private readonly repos: UnwinderRepositories,
    options: UnwinderOptions
  ) {
    this.waitMs = options.waitMs;
  }

  async unwind(
    position: RecordedPosition,
    filledLeg: FilledLegDescriptor,
    clients: TradingClients
  ): Promise<RecordedPosition> {
    if (position.status !== "partial") {
      return position;
    }

    await this.delay(this.waitMs);

    const reverseSide: ContractSide = filledLeg.side === "YES" ? "NO" : "YES";
    const reversePrice = round4(1 - filledLeg.price);
    const client = filledLeg.venue === "kalshi" ? clients.kalshi : clients.polymarket;

    const result = await client.placeOrder(filledLeg.market, reverseSide, reversePrice, filledLeg.size);

    if (result.filled) {
      // Unwind succeeded — record the realised P&L and close the position.
      // Holding the original leg plus the reverse (YES+NO) resolves to $1, so
      // the realised P&L is 1 − originalFillPrice − reverseFillPrice.
      const pnl = round4(1 - filledLeg.price - result.fillPrice);
      return await this.repos.positions.update(position.id, { status: "closed", pnl: String(pnl) });
    }

    // Unwind failed — mark exposed and persist an alert.
    await this.repos.alerts.insert({
      opportunityId: position.opportunityId,
      channel: UNWIND_ALERT_CHANNEL,
      payload: {
        positionId: position.id,
        venue: filledLeg.venue,
        market: filledLeg.market,
        side: filledLeg.side,
        price: filledLeg.price,
        size: filledLeg.size,
        error: result.error ?? "unknown"
      }
    });
    return await this.repos.positions.update(position.id, { status: "exposed" });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}