import type { CrossVenueOpportunity } from "../../arbitrage/domain/opportunity";
import { RiskManager } from "./risk-manager";
import { PositionUnwinder, type FilledLegDescriptor } from "./position-unwinder";

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
 *
 * `placeOrder` accepts an optional `AbortSignal` so the orchestrator can
 * abort in-flight requests when its timeout wins the race.
 */
export interface TradingClient {
  placeOrder(market: string, side: string, price: number, size: number, signal?: AbortSignal): Promise<LegFillResult>;
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
 * Thrown when `execute()` is called for an opportunity that already has a
 * non-terminal position, enforcing idempotency so the same opportunity is
 * never executed twice.
 */
export class AlreadyExecutedError extends Error {
  constructor(public readonly opportunityId: string, public readonly existingStatus: string) {
    super(`Opportunity ${opportunityId} already executed (position status: ${existingStatus})`);
    this.name = "AlreadyExecutedError";
  }
}

/**
 * Thrown when the RiskManager rejects the execution because it would breach
 * the max-capital-deployed limit.
 */
export class RiskRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskRejectedError";
  }
}

/**
 * Thrown when the opportunity's quote is too stale or the opportunity itself
 * is too old, based on configurable pre-flight guards. Carries the offending
 * value and configured limit so callers can report a precise operator-safe
 * message without leaking internal stack traces.
 */
export class StaleOpportunityRejectedError extends Error {
  constructor(
    message: string,
    public readonly kind: "quote-staleness" | "opportunity-age",
    public readonly value: number,
    public readonly limit: number
  ) {
    super(message);
    this.name = "StaleOpportunityRejectedError";
  }
}

/**
 * Thrown when the order size is not a positive finite number, preventing
 * zero/NaN orders from being sent to venue APIs.
 */
export class InvalidOrderSizeError extends Error {
  constructor(public readonly size: number) {
    super(`Order size must be a positive finite number, got: ${size}`);
    this.name = "InvalidOrderSizeError";
  }
}

/**
 * Persistence sink the orchestrator writes orders/fills/positions through.
 * Tests pass an in-memory implementation; production passes a drizzle-backed
 * implementation. The interface mirrors only the insert surface the
 * orchestrator needs.
 *
 * `positions.getStatusForOpportunity` is optional — when absent the orchestrator
 * skips the idempotency check (tests that don't care can omit it).
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
    /**
     * Returns the status of an existing position for the given opportunity
     * id, or null when no position exists. Optional — the orchestrator skips
     * the idempotency check when this is not provided.
     *
     * (Replaces the old boolean `existsForOpportunity` — now returns the
     * actual status string so `AlreadyExecutedError` can carry it.)
     */
    getStatusForOpportunity?(opportunityId: string): Promise<string | null> | string | null;
    /**
     * Returns the current total open notional across all positions, for the
     * risk guard's pre-trade check. Optional — when absent the orchestrator
     * falls back to the constructor-provided `totalOpenNotional`.
     */
    getTotalOpenNotional?(): Promise<number> | number;
  };
}

/**
 * Optional dependencies injected into the orchestrator. When omitted, the
 * corresponding behaviour is skipped (risk check / auto-unwind), keeping the
 * orchestrator usable in minimal test setups.
 */
export interface ExecutionOrchestratorOptions {
  /** Pre-trade risk guard. When provided, `execute()` calls it before placing orders. */
  riskManager?: RiskManager;
  /** Auto-unwinder for partial fills. When provided, `execute()` calls it after a partial fill. */
  unwinder?: PositionUnwinder;
  /** Current total open notional across all positions. Used for the risk check. Defaults to 0. */
  totalOpenNotional?: number;
  /** Max capital deployable across all positions. Used for the risk check. */
  maxCapitalDeployed?: number;
  /**
   * Quote-staleness guard (ms). When set to a finite positive number, the
   * orchestrator rejects opportunities whose `dataStalenessMs` is missing,
   * non-finite, negative, or greater than this limit. Omit or leave `undefined`
   * to preserve prior behaviour (no guard).
   */
  maxQuoteStalenessMs?: number;
  /**
   * Opportunity-age guard (ms). When set to a finite positive number, the
   * orchestrator rejects opportunities whose `opportunityAgeMs` is missing,
   * non-finite, negative, or greater than this limit. Omit or leave `undefined`
   * to preserve prior behaviour (no guard).
   */
  maxOpportunityAgeMs?: number;
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
 *
 * Idempotency: when `repos.positions.getStatusForOpportunity` is available,
 * `execute()` refuses to re-execute an opportunity that already has a
 * non-terminal position (`open`, `partial`, `exposed`), throwing
 * `AlreadyExecutedError`.
 *
 * NOTE: The idempotency check is not atomic — there is a TOCTOU window
 * between the `getStatusForOpportunity` read and the `positions.insert`
 * write. For the single-user CLI runbook use case this is acceptable.
 * If concurrent orchestrator instances are ever introduced, a unique
 * constraint on `positions.opportunity_id` should be added at the DB
 * level to enforce atomicity.
 *
 * Freshness: when `options.maxQuoteStalenessMs` or `options.maxOpportunityAgeMs`
 * are provided as finite positive numbers, `execute()` validates the
 * opportunity metadata before placing orders and throws
 * `StaleOpportunityRejectedError` if the quote is too stale or the opportunity
 * is too old. Non-finite or negative metadata is rejected when the guard is
 * enabled. Omitting these options preserves the prior behaviour (no guard).
 *
 * Risk: when `options.riskManager` is provided, `execute()` calls
 * `riskManager.checkExecution(totalOpenNotional, requestedNotional, maxCapitalDeployed)`
 * before placing orders and throws `RiskRejectedError` if rejected.
 * The `totalOpenNotional` is fetched at execution time via
 * `repos.positions.getTotalOpenNotional()` when available, falling back
 * to the constructor value. Like the idempotency check, this read is
 * not transactional with the position insert — concurrent executions
 * could breach the limit. Acceptable for single-user CLI use.
 *
 * Unwinding: when `options.unwinder` is provided and the position ends up
 * `partial`, the unwinder is automatically invoked to reverse the filled leg.
 */
export class ExecutionOrchestrator {
  /** Hardcoded 30s leg timeout. Not configurable — by design (issue #79). */
  static readonly TIMEOUT_MS = 30_000;

  private readonly riskManager?: RiskManager;
  private readonly unwinder?: PositionUnwinder;
  private readonly totalOpenNotional: number;
  private readonly maxCapitalDeployed: number;
  private readonly maxQuoteStalenessMs?: number;
  private readonly maxOpportunityAgeMs?: number;

  constructor(
    private readonly repos: ExecutionRepositories,
    options: ExecutionOrchestratorOptions = {}
  ) {
    this.riskManager = options.riskManager;
    this.unwinder = options.unwinder;
    this.totalOpenNotional = options.totalOpenNotional ?? 0;
    this.maxCapitalDeployed = options.maxCapitalDeployed ?? 0;
    this.maxQuoteStalenessMs = options.maxQuoteStalenessMs;
    this.maxOpportunityAgeMs = options.maxOpportunityAgeMs;
  }

  async execute(opportunity: CrossVenueOpportunity, clients: TradingClients): Promise<ExecutionResult> {
    // Idempotency: refuse to re-execute an opportunity that already has a
    // non-terminal position.
    if (typeof this.repos.positions.getStatusForOpportunity === "function") {
      const existingStatus = await this.repos.positions.getStatusForOpportunity(opportunity.id);
      if (existingStatus) {
        throw new AlreadyExecutedError(opportunity.id, existingStatus);
      }
    }

    const kalshiLeg = this.toLegSubmission(opportunity, opportunity.longLeg);
    const polyLeg = this.toLegSubmission(opportunity, opportunity.hedgeLeg);

    // Validate order sizes before placing orders.
    if (!Number.isFinite(kalshiLeg.size) || kalshiLeg.size <= 0) {
      throw new InvalidOrderSizeError(kalshiLeg.size);
    }
    if (!Number.isFinite(polyLeg.size) || polyLeg.size <= 0) {
      throw new InvalidOrderSizeError(polyLeg.size);
    }

    // Freshness guard: fail-closed pre-flight check on quote staleness and
    // opportunity age before any venue interaction.
    this.checkFreshness(opportunity);

    // Pre-trade risk guard: reject if total open + requested exceeds max.
    if (this.riskManager) {
      // Fetch the current total open notional at execution time, not from
      // a stale constructor snapshot. Falls back to the constructor value
      // when the repos doesn't provide a live fetcher.
      const currentOpenNotional = typeof this.repos.positions.getTotalOpenNotional === "function"
        ? await this.repos.positions.getTotalOpenNotional()
        : this.totalOpenNotional;
      const requestedNotional = kalshiLeg.size + polyLeg.size;
      const allowed = this.riskManager.checkExecution(
        currentOpenNotional,
        requestedNotional,
        this.maxCapitalDeployed
      );
      if (!allowed) {
        throw new RiskRejectedError(
          `Execution rejected by RiskManager: total open ${currentOpenNotional} + requested ${requestedNotional} exceeds max ${this.maxCapitalDeployed}`
        );
      }
    }

    // `Promise.allSettled` ensures a rejection on one leg (network error,
    // venue rejection) does not short-circuit the other — both legs always
    // run to completion (or the 30s timeout) before we decide position
    // status. Each leg receives the AbortSignal so in-flight requests are
    // cancelled when the timeout wins.
    const [kalshiSettled, polySettled] = await Promise.allSettled([
      this.raceWithTimeout((signal) => clients.kalshi.placeOrder(kalshiLeg.market, kalshiLeg.side, kalshiLeg.price, kalshiLeg.size, signal)),
      this.raceWithTimeout((signal) => clients.polymarket.placeOrder(polyLeg.market, polyLeg.side, polyLeg.price, polyLeg.size, signal))
    ]);

    const kalshiResult = this.toLegResult(kalshiSettled);
    const polyResult = this.toLegResult(polySettled);

    // Persist both orders regardless of outcome. The status distinguishes
    // between venue rejections ("failed") and local timeouts ("timeout").
    const kalshiOrder = await this.repos.orders.insert({
      venue: "kalshi",
      market: kalshiLeg.market,
      side: kalshiLeg.side,
      price: String(kalshiLeg.price),
      size: String(kalshiLeg.size),
      status: this.toOrderStatus(kalshiResult)
    });
    const polyOrder = await this.repos.orders.insert({
      venue: "polymarket",
      market: polyLeg.market,
      side: polyLeg.side,
      price: String(polyLeg.price),
      size: String(polyLeg.size),
      status: this.toOrderStatus(polyResult)
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

    // Auto-unwind partial positions when an unwinder is injected.
    if (position && position.status === "partial" && this.unwinder) {
      const filledLeg = kalshiFilled
        ? this.toFilledLegDescriptor(opportunity.longLeg, "kalshi", kalshiResult)
        : this.toFilledLegDescriptor(opportunity.hedgeLeg, "polymarket", polyResult);
      position = await this.unwinder.unwind(position, filledLeg, clients);
    }

    return { position, legs: { kalshi: kalshiResult, polymarket: polyResult } };
  }

  /**
   * Fail-closed freshness guard. When a limit is configured as a finite
   * positive number, the corresponding metadata field must also be a finite
   * non-negative number and must not exceed the limit. Violations are
   * surfaced as `StaleOpportunityRejectedError` before any venue interaction.
   */
  private checkFreshness(opportunity: CrossVenueOpportunity): void {
    if (this.maxQuoteStalenessMs !== undefined && Number.isFinite(this.maxQuoteStalenessMs) && this.maxQuoteStalenessMs > 0) {
      const value = opportunity.dataStalenessMs;
      if (!Number.isFinite(value) || value < 0) {
        throw new StaleOpportunityRejectedError(
          `Quote staleness metadata is invalid (got ${value}); rejecting execution under freshness guard (limit ${this.maxQuoteStalenessMs} ms)`,
          "quote-staleness",
          value,
          this.maxQuoteStalenessMs
        );
      }
      if (value > this.maxQuoteStalenessMs) {
        throw new StaleOpportunityRejectedError(
          `Quote is too stale: ${value} ms exceeds max ${this.maxQuoteStalenessMs} ms`,
          "quote-staleness",
          value,
          this.maxQuoteStalenessMs
        );
      }
    }

    if (this.maxOpportunityAgeMs !== undefined && Number.isFinite(this.maxOpportunityAgeMs) && this.maxOpportunityAgeMs > 0) {
      const value = opportunity.opportunityAgeMs;
      if (!Number.isFinite(value) || value < 0) {
        throw new StaleOpportunityRejectedError(
          `Opportunity age metadata is invalid (got ${value}); rejecting execution under freshness guard (limit ${this.maxOpportunityAgeMs} ms)`,
          "opportunity-age",
          value,
          this.maxOpportunityAgeMs
        );
      }
      if (value > this.maxOpportunityAgeMs) {
        throw new StaleOpportunityRejectedError(
          `Opportunity is too old: ${value} ms exceeds max ${this.maxOpportunityAgeMs} ms`,
          "opportunity-age",
          value,
          this.maxOpportunityAgeMs
        );
      }
    }
  }

  private toLegSubmission(
    opportunity: CrossVenueOpportunity,
    leg: CrossVenueOpportunity["longLeg"]
  ): { market: string; side: string; price: number; size: number } {
    const executableSize = opportunity.executableSizeUsd > 0 ? opportunity.executableSizeUsd : opportunity.maxTradableUsd;
    return {
      market: leg.marketId,
      side: leg.side,
      price: leg.askPrice,
      size: executableSize
    };
  }

  private toFilledLegDescriptor(
    leg: CrossVenueOpportunity["longLeg"],
    venue: "kalshi" | "polymarket",
    result: LegFillResult
  ): FilledLegDescriptor {
    return {
      venue,
      market: leg.marketId,
      side: leg.side,
      price: result.fillPrice,
      size: result.fillSize
    };
  }

  /**
   * Races a leg promise against a 30s timeout. When the timeout wins,
   * the `AbortController` is aborted so any in-flight request is cancelled
   * rather than left running in the background. The `start` callback receives
   * the signal so the underlying request can observe the abort.
   */
  private async raceWithTimeout(start: (signal: AbortSignal) => Promise<LegFillResult>): Promise<LegFillResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LegFillResult>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort();
          resolve({ orderId: "", filled: false, fillPrice: 0, fillSize: 0, error: "timeout" });
        },
        ExecutionOrchestrator.TIMEOUT_MS
      );
    });
    try {
      return await Promise.race([start(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Maps a leg result to an order status for the audit trail.
   * Filled → "filled", timeout → "timeout", everything else → "failed".
   */
  private toOrderStatus(result: LegFillResult): string {
    if (result.filled) return "filled";
    if (result.error === "timeout") return "timeout";
    return "failed";
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