import { describe, expect, it, vi } from "vitest";
import {
  ExecutionOrchestrator,
  AlreadyExecutedError,
  RiskRejectedError,
  type TradingClient,
  type RecordedOrder,
  type RecordedFill,
  type RecordedPosition,
  type ExecutionRepositories
} from "../src/contexts/execution/application/execution-orchestrator";
import { RiskManager } from "../src/contexts/execution/application/risk-manager";
import { PositionUnwinder, type UnwinderRepositories, type FilledLegDescriptor } from "../src/contexts/execution/application/position-unwinder";
import type { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import { orders, fills, positions } from "../src/db/schema";

/**
 * Minimal fixture: a Kalshi-YES / Polymarket-NO opportunity with both legs
 * pointing at known markets. The orchestrator only needs longLeg/hedgeLeg to
 * carry venue, marketId, side, askPrice, and an executable size; the rest of
 * the CrossVenueOpportunity fields are filled with sane defaults so the
 * object type-checks.
 */
function fixtureOpportunity(): CrossVenueOpportunity {
  return {
    id: "opp-1",
    pairId: "pair-1",
    longLeg: {
      venue: "kalshi",
      marketId: "KXBTC-100K",
      side: "YES",
      askPrice: 0.55,
      availableUsd: 100,
      feeRate: 0.01,
      slippageRate: 0.005,
      depthLevels: []
    },
    hedgeLeg: {
      venue: "polymarket",
      marketId: "token-123",
      side: "NO",
      askPrice: 0.42,
      availableUsd: 100,
      feeRate: 0.01,
      slippageRate: 0.005,
      depthLevels: []
    },
    combinedCost: 0.97,
    grossEdge: 0.03,
    estimatedFees: 0.0097,
    estimatedSlippage: 0.00485,
    netEdge: 0.01545,
    theoreticalCombinedCost: 0.97,
    theoreticalGrossEdge: 0.03,
    theoreticalNetEdge: 0.01545,
    executableSizeUsd: 50,
    executableCombinedCost: 0.97,
    executableGrossEdge: 0.03,
    executableNetEdge: 0.01545,
    maxTradableUsd: 100,
    notionalEdges: [],
    equivalenceClass: "A",
    resolutionRisk: "low",
    fillRisk: "low",
    liquidityRisk: "low",
    venueRisk: "low",
    equivalenceRisk: "low",
    dataStalenessMs: 0,
    opportunityAgeMs: 0,
    detectedAt: "2026-07-01T00:00:00Z",
    firstDetectedAt: "2026-07-01T00:00:00Z",
    lastVerifiedAt: "2026-07-01T00:00:00Z",
    calculationVersion: "test-v1",
    configVersion: "test-v1"
  };
}

/**
 * In-memory persistence sink that mimics the minimal drizzle insert/select
 * surface used by ExecutionOrchestrator. Each table is an array of rows; the
 * repository returns inserted rows so tests can assert on recorded state
 * without a live database.
 */
function inMemoryRepositories(existsForOpportunity?: (id: string) => boolean) {
  const ordersRows: RecordedOrder[] = [];
  const fillsRows: RecordedFill[] = [];
  const positionsRows: RecordedPosition[] = [];

  const repos: ExecutionRepositories & {
    orders: ExecutionRepositories["orders"] & { all: () => RecordedOrder[] };
    fills: ExecutionRepositories["fills"] & { all: () => RecordedFill[] };
    positions: ExecutionRepositories["positions"] & { all: () => RecordedPosition[] };
  } = {
    orders: {
      insert(row: { venue: string; market: string; side: string; price: string; size: string; status: string }): RecordedOrder {
        const withId: RecordedOrder = {
          id: `ord-${ordersRows.length + 1}`,
          venue: row.venue,
          market: row.market,
          side: row.side,
          price: row.price,
          size: row.size,
          status: row.status
        };
        ordersRows.push(withId);
        return withId;
      },
      all: () => ordersRows
    },
    fills: {
      insert(row: { orderId: string; fillPrice: string; fillSize: string }): RecordedFill {
        const withId: RecordedFill = {
          id: `fill-${fillsRows.length + 1}`,
          orderId: row.orderId,
          fillPrice: row.fillPrice,
          fillSize: row.fillSize
        };
        fillsRows.push(withId);
        return withId;
      },
      all: () => fillsRows
    },
    positions: {
      insert(row: {
        opportunityId: string;
        kalshiOrderId: string | null;
        polyOrderId: string | null;
        status: string;
        pnl?: string;
      }): RecordedPosition {
        const withId: RecordedPosition = {
          id: `pos-${positionsRows.length + 1}`,
          opportunityId: row.opportunityId,
          kalshiOrderId: row.kalshiOrderId,
          polyOrderId: row.polyOrderId,
          status: row.status as RecordedPosition["status"]
        };
        positionsRows.push(withId);
        return withId;
      },
      all: () => positionsRows,
      ...(existsForOpportunity ? { existsForOpportunity } : {})
    }
  };
  return repos;
}

function mockKalshiClient(orderId: string, filled: boolean, fillSize: number, fillPrice: number): TradingClient {
  return {
    placeOrder: vi.fn(async () => ({
      orderId,
      filled,
      fillPrice,
      fillSize
    })),
    cancelOrder: vi.fn(async () => {})
  };
}

function mockPolymarketClient(orderId: string, filled: boolean, fillSize: number, fillPrice: number): TradingClient {
  return {
    placeOrder: vi.fn(async () => ({
      orderId,
      filled,
      fillPrice,
      fillSize
    })),
    cancelOrder: vi.fn(async () => {})
  };
}

describe("ExecutionOrchestrator", () => {
  it("records an open position with both order ids when both legs fill", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    const orchestrator = new ExecutionOrchestrator(repos);
    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });

    // Both orders persisted with filled status.
    const ordersRows = repos.orders.all();
    expect(ordersRows).toHaveLength(2);
    const statuses = ordersRows.map((o) => o.status);
    expect(statuses).toContain("filled");
    expect(statuses.filter((s) => s === "filled")).toHaveLength(2);

    // A position is recorded as open referencing both leg order rows.
    const positionsRows = repos.positions.all();
    expect(positionsRows).toHaveLength(1);
    expect(positionsRows[0].status).toBe("open");
    const kalshiOrderRow = ordersRows.find((o) => o.venue === "kalshi")!;
    const polyOrderRow = ordersRows.find((o) => o.venue === "polymarket")!;
    expect(positionsRows[0].kalshiOrderId).toBe(kalshiOrderRow.id);
    expect(positionsRows[0].polyOrderId).toBe(polyOrderRow.id);

    // Fills persisted for both legs.
    expect(repos.fills.all()).toHaveLength(2);

    // The return value matches the recorded position.
    expect(result.position).toBeDefined();
    expect(result.position!.status).toBe("open");
  });

  it("marks the position partial when one leg fills and the other fails", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-2", true, 10, 0.55);
    const poly: TradingClient = {
      placeOrder: vi.fn(async () => {
        throw new Error("polymarket order rejected");
      }),
      cancelOrder: vi.fn(async () => {})
    };

    const orchestrator = new ExecutionOrchestrator(repos);
    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });

    const positionsRows = repos.positions.all();
    expect(positionsRows).toHaveLength(1);
    expect(positionsRows[0].status).toBe("partial");
    expect(result.position!.status).toBe("partial");

    // Only the filled leg recorded a fill.
    expect(repos.fills.all()).toHaveLength(1);
    // The failed order is persisted as failed.
    const failedOrders = repos.orders.all().filter((o) => o.status === "failed");
    expect(failedOrders).toHaveLength(1);
  });

  it("creates no position when both legs fail", async () => {
    const repos = inMemoryRepositories();
    const kalshi: TradingClient = {
      placeOrder: vi.fn(async () => {
        throw new Error("kalshi order rejected");
      }),
      cancelOrder: vi.fn(async () => {})
    };
    const poly: TradingClient = {
      placeOrder: vi.fn(async () => {
        throw new Error("polymarket order rejected");
      }),
      cancelOrder: vi.fn(async () => {})
    };

    const orchestrator = new ExecutionOrchestrator(repos);
    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });

    expect(repos.positions.all()).toHaveLength(0);
    expect(result.position).toBeUndefined();
    // Both orders persisted as failed.
    const failedOrders = repos.orders.all().filter((o) => o.status === "failed");
    expect(failedOrders).toHaveLength(2);
    // No fills recorded.
    expect(repos.fills.all()).toHaveLength(0);
  });

  it("uses a hardcoded 30s timeout", async () => {
    // The orchestrator exposes the constant for inspection; it must not be
    // derived from config or constructor options.
    expect(ExecutionOrchestrator.TIMEOUT_MS).toBe(30_000);
  });

  it("exposes the new execution tables in the schema", () => {
    expect(orders).toBeDefined();
    expect(fills).toBeDefined();
    expect(positions).toBeDefined();
  });

  // --- Fix 3: idempotency ---
  it("refuses to re-execute when a position already exists for the opportunity (non-terminal)", async () => {
    const repos = inMemoryRepositories(() => true);
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    const orchestrator = new ExecutionOrchestrator(repos);
    await expect(
      orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly })
    ).rejects.toBeInstanceOf(AlreadyExecutedError);

    // No orders should have been placed.
    expect(kalshi.placeOrder).not.toHaveBeenCalled();
    expect(poly.placeOrder).not.toHaveBeenCalled();
  });

  it("executes when no existing position is found", async () => {
    const repos = inMemoryRepositories(() => false);
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    const orchestrator = new ExecutionOrchestrator(repos);
    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });
    expect(result.position).toBeDefined();
    expect(result.position!.status).toBe("open");
  });

  // --- Fix 6: RiskManager ---
  it("rejects execution when over the capital limit", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    // requestedNotional = 50 + 50 = 100; totalOpen 4950 + 100 = 5050 > 5000
    const orchestrator = new ExecutionOrchestrator(repos, {
      riskManager: new RiskManager(),
      totalOpenNotional: 4950,
      maxCapitalDeployed: 5000
    });

    await expect(
      orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly })
    ).rejects.toBeInstanceOf(RiskRejectedError);

    // No orders placed.
    expect(kalshi.placeOrder).not.toHaveBeenCalled();
    expect(poly.placeOrder).not.toHaveBeenCalled();
  });

  it("allows execution when within the capital limit", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    // requestedNotional = 50 + 50 = 100; totalOpen 1000 + 100 = 1100 <= 5000
    const orchestrator = new ExecutionOrchestrator(repos, {
      riskManager: new RiskManager(),
      totalOpenNotional: 1000,
      maxCapitalDeployed: 5000
    });

    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });
    expect(result.position).toBeDefined();
  });

  // --- Fix 7: PositionUnwinder auto-unwind on partial fill ---
  it("automatically calls the unwinder when a partial fill occurs", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-2", true, 50, 0.55);
    const poly: TradingClient = {
      placeOrder: vi.fn(async () => {
        throw new Error("polymarket order rejected");
      }),
      cancelOrder: vi.fn(async () => {})
    };

    // Minimal in-memory unwinder repos that share the positions array.
    const positionsRows = repos.positions.all();
    const unwinderRepos: UnwinderRepositories = {
      positions: {
        update(id: string, row: { status: string; pnl?: string }): RecordedPosition {
          const existing = positionsRows.find((p) => p.id === id);
          if (existing) {
            existing.status = row.status as RecordedPosition["status"];
          }
          return existing ?? { id, opportunityId: "", kalshiOrderId: null, polyOrderId: null, status: row.status as RecordedPosition["status"] };
        }
      },
      alerts: {
        insert(): void {}
      }
    };

    const unwindSpy = vi.fn(async (_position: RecordedPosition, _leg: FilledLegDescriptor) => Promise.resolve(_position));
    // Wrap PositionUnwinder so we can assert it was called.
    const unwinder = new PositionUnwinder(unwinderRepos, { waitMs: 0 });
    const unwindMethod = vi.spyOn(unwinder, "unwind").mockImplementation(async (position, leg, _clients) => {
      unwindSpy(position, leg);
      // Simulate a successful unwind → position becomes closed.
      const updated = unwinderRepos.positions.update(position.id, { status: "closed", pnl: "0.0" });
      return updated;
    });

    const orchestrator = new ExecutionOrchestrator(repos, { unwinder });
    const result = await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });

    // The unwinder must have been called with the partial position.
    expect(unwindMethod).toHaveBeenCalledTimes(1);
    const [unwoundPosition, filledLeg] = unwindMethod.mock.calls[0];
    expect(unwoundPosition.opportunityId).toBe("opp-1");
    expect(filledLeg.venue).toBe("kalshi");
    expect(filledLeg.market).toBe("KXBTC-100K");

    // The position should now be closed after unwind.
    expect(result.position!.status).toBe("closed");
  });

  it("does not call the unwinder when both legs fill (open position)", async () => {
    const repos = inMemoryRepositories();
    const kalshi = mockKalshiClient("kal-ord-1", true, 10, 0.55);
    const poly = mockPolymarketClient("poly-ord-1", true, 10, 0.42);

    const unwinderRepos: UnwinderRepositories = {
      positions: { update: vi.fn(async (id): Promise<RecordedPosition> => ({ id, opportunityId: "", kalshiOrderId: null, polyOrderId: null, status: "closed" })) },
      alerts: { insert: vi.fn(async () => {}) }
    };
    const unwinder = new PositionUnwinder(unwinderRepos, { waitMs: 0 });
    const unwindMethod = vi.spyOn(unwinder, "unwind");

    const orchestrator = new ExecutionOrchestrator(repos, { unwinder });
    await orchestrator.execute(fixtureOpportunity(), { kalshi, polymarket: poly });

    expect(unwindMethod).not.toHaveBeenCalled();
  });
});