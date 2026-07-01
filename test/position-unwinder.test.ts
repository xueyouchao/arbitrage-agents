import { describe, expect, it, vi } from "vitest";
import { PositionUnwinder } from "../src/contexts/execution/application/position-unwinder";
import type { TradingClient, RecordedPosition } from "../src/contexts/execution/application/execution-orchestrator";
import type { FilledLegDescriptor, UnwinderRepositories } from "../src/contexts/execution/application/position-unwinder";

function mockClient(orderId: string, filled: boolean, fillSize: number, fillPrice: number): TradingClient {
  return {
    placeOrder: vi.fn(async () => ({ orderId, filled, fillPrice, fillSize })),
    cancelOrder: vi.fn(async () => {})
  };
}

function inMemoryRepos() {
  const positionsRows: RecordedPosition[] = [];
  const alertsRows: { opportunityId: string; channel: string; payload: Record<string, unknown> }[] = [];

  const repos: UnwinderRepositories & {
    positions: UnwinderRepositories["positions"] & { all: () => RecordedPosition[] };
    alerts: UnwinderRepositories["alerts"] & { all: () => typeof alertsRows };
  } = {
    positions: {
      update(id, row) {
        const existing = positionsRows.find((p) => p.id === id);
        if (existing) {
          existing.status = row.status as RecordedPosition["status"];
          if (row.pnl !== undefined) (existing as RecordedPosition & { pnl?: string }).pnl = row.pnl;
        }
        return existing ?? ({ id, opportunityId: "", kalshiOrderId: null, polyOrderId: null, status: row.status as RecordedPosition["status"] } as RecordedPosition);
      },
      all: () => positionsRows
    },
    alerts: {
      insert(row) {
        alertsRows.push(row);
      },
      all: () => alertsRows
    }
  };
  return { repos, positionsRows, alertsRows };
}

function partialPosition(filledVenue: "kalshi" | "polymarket"): RecordedPosition {
  return {
    id: "pos-1",
    opportunityId: "opp-1",
    kalshiOrderId: filledVenue === "kalshi" ? "ord-kal-1" : null,
    polyOrderId: filledVenue === "polymarket" ? "ord-poly-1" : null,
    status: "partial"
  };
}

describe("PositionUnwinder", () => {
  it("places a reverse order on the filled leg when unwinding a partial position", async () => {
    const { repos } = inMemoryRepos();
    const position = partialPosition("kalshi");
    const filledLeg: FilledLegDescriptor = {
      venue: "kalshi",
      market: "KXBTC-100K",
      side: "YES",
      price: 0.55,
      size: 50
    };
    const kalshi = mockClient("unwind-ord-1", true, 50, 0.45);
    const polymarket = mockClient("", false, 0, 0);

    const unwinder = new PositionUnwinder(repos, { waitMs: 0 });
    await unwinder.unwind(position, filledLeg, { kalshi, polymarket });

    // The kalshi client should have been called with the reverse side (NO)
    // on the same market, with the complementary price (1 - 0.55 = 0.45)
    // and the same size.
    expect(kalshi.placeOrder).toHaveBeenCalledWith("KXBTC-100K", "NO", 0.45, 50);
    // The polymarket client should not have been touched.
    expect(polymarket.placeOrder).not.toHaveBeenCalled();
  });

  it("marks the position closed when the unwind reverse order fills", async () => {
    const { repos, positionsRows } = inMemoryRepos();
    const position = positionsRows.length > 0 ? positionsRows[0] : partialPosition("polymarket");
    positionsRows.push({ ...position });
    const filledLeg: FilledLegDescriptor = {
      venue: "polymarket",
      market: "token-123",
      side: "NO",
      price: 0.42,
      size: 25
    };
    // Reverse side is YES, reverse price is 1 - 0.42 = 0.58, fills at 0.55.
    const polymarket = mockClient("unwind-poly-1", true, 25, 0.55);
    const kalshi = mockClient("", false, 0, 0);

    const unwinder = new PositionUnwinder(repos, { waitMs: 0 });
    const result = await unwinder.unwind(positionsRows[0], filledLeg, { kalshi, polymarket });

    // The reverse order was placed as YES at the complement price.
    expect(polymarket.placeOrder).toHaveBeenCalledWith("token-123", "YES", 0.58, 25);
    // Position is now closed.
    expect(result.status).toBe("closed");
    const updated = repos.positions.all().find((p) => p.id === positionsRows[0].id);
    expect(updated?.status).toBe("closed");
    // P&L recorded: 1 - originalPrice(0.42) - reverseFillPrice(0.55) = 0.03.
    expect((result as RecordedPosition & { pnl?: string }).pnl).toBe("0.03");
    // No alert should have been emitted on success.
    expect(repos.alerts.all()).toHaveLength(0);
  });

  it("marks the position exposed and persists an alert when the unwind fails", async () => {
    const { repos, positionsRows } = inMemoryRepos();
    const position = partialPosition("kalshi");
    positionsRows.push({ ...position });
    const filledLeg: FilledLegDescriptor = {
      venue: "kalshi",
      market: "KXBTC-100K",
      side: "YES",
      price: 0.55,
      size: 50
    };
    // Reverse order fails.
    const kalshi: TradingClient = {
      placeOrder: vi.fn(async () => ({ orderId: "", filled: false, fillPrice: 0, fillSize: 0, error: "no liquidity" })),
      cancelOrder: vi.fn(async () => {})
    };
    const polymarket = mockClient("", false, 0, 0);

    const unwinder = new PositionUnwinder(repos, { waitMs: 0 });
    const result = await unwinder.unwind(positionsRows[0], filledLeg, { kalshi, polymarket });

    // Position is now exposed (naked).
    expect(result.status).toBe("exposed");
    const updated = repos.positions.all().find((p) => p.id === positionsRows[0].id);
    expect(updated?.status).toBe("exposed");

    // An alert was persisted to the alerts table.
    const alerts = repos.alerts.all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].opportunityId).toBe(position.opportunityId);
    expect(alerts[0].payload).toMatchObject({
      positionId: position.id,
      venue: "kalshi",
      market: "KXBTC-100K",
      side: "YES",
      error: "no liquidity"
    });
  });

  it("does not unwind a position that is already open (both legs filled)", async () => {
    const { repos, positionsRows } = inMemoryRepos();
    const openPosition: RecordedPosition = {
      id: "pos-open-1",
      opportunityId: "opp-2",
      kalshiOrderId: "ord-kal-2",
      polyOrderId: "ord-poly-2",
      status: "open"
    };
    positionsRows.push({ ...openPosition });
    const filledLeg: FilledLegDescriptor = {
      venue: "kalshi",
      market: "KXBTC-100K",
      side: "YES",
      price: 0.55,
      size: 50
    };
    const kalshi = mockClient("should-not-be-called", true, 50, 0.45);
    const polymarket = mockClient("should-not-be-called", true, 50, 0.45);

    const unwinder = new PositionUnwinder(repos, { waitMs: 0 });
    const result = await unwinder.unwind(openPosition, filledLeg, { kalshi, polymarket });

    // No reverse order placed on either venue.
    expect(kalshi.placeOrder).not.toHaveBeenCalled();
    expect(polymarket.placeOrder).not.toHaveBeenCalled();
    // Position remains open, unchanged.
    expect(result.status).toBe("open");
    // No alerts emitted.
    expect(repos.alerts.all()).toHaveLength(0);
  });

  it("does not unwind a position that is already closed", async () => {
    const { repos, positionsRows } = inMemoryRepos();
    const closedPosition: RecordedPosition = {
      id: "pos-closed-1",
      opportunityId: "opp-3",
      kalshiOrderId: "ord-kal-3",
      polyOrderId: "ord-poly-3",
      status: "closed"
    };
    positionsRows.push({ ...closedPosition });
    const filledLeg: FilledLegDescriptor = {
      venue: "polymarket",
      market: "token-999",
      side: "NO",
      price: 0.42,
      size: 25
    };
    const kalshi = mockClient("nope", true, 25, 0.58);
    const polymarket = mockClient("nope", true, 25, 0.58);

    const unwinder = new PositionUnwinder(repos, { waitMs: 0 });
    const result = await unwinder.unwind(closedPosition, filledLeg, { kalshi, polymarket });

    expect(kalshi.placeOrder).not.toHaveBeenCalled();
    expect(polymarket.placeOrder).not.toHaveBeenCalled();
    expect(result.status).toBe("closed");
    expect(repos.alerts.all()).toHaveLength(0);
  });
});