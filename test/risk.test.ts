import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAll,
  recordFill,
  recordPnl,
  resetForBacktest,
  positionSize,
  getState,
  weeklySharpe,
} from "../src/risk/gates.js";
import type { Signal } from "../src/signal/edge.js";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    conditionId: "0xtest",
    side: "up",
    fair: 0.7,
    market: 0.6,
    edge: 0.1,
    tauSec: 600,
    sigma: 0.5,
    asset: "BTC",
    horizon: "1h",
    reason: "test",
    ...overrides,
  };
}

beforeEach(() => {
  resetForBacktest(10_000);
});

describe("positionSize()", () => {
  it("caps at 2% of bankroll", () => {
    expect(positionSize(makeSignal())).toBe(200);
  });
  it("caps at hard $1000 max", () => {
    resetForBacktest(100_000);
    expect(positionSize(makeSignal())).toBe(1000);
  });
  it("returns 0 when bankroll is 0", () => {
    resetForBacktest(0);
    expect(positionSize(makeSignal())).toBe(0);
  });
});

describe("checkAll()", () => {
  it("approves a valid signal", () => {
    const r = checkAll(makeSignal());
    expect(r.ok).toBe(true);
    expect(r.sizedUsdc).toBe(200);
  });
  it("blocks when edge is below threshold", () => {
    const r = checkAll(makeSignal({ edge: 0.005 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("edge_below_threshold");
  });
  it("blocks when market is expired (tauSec = 0)", () => {
    const r = checkAll(makeSignal({ tauSec: 0 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("market_expired");
  });
  it("blocks after max open positions", () => {
    recordFill("buy", 100);
    recordFill("buy", 100);
    recordFill("buy", 100);
    const r = checkAll(makeSignal());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("max_open_positions");
  });
  it("blocks after daily drawdown exceeded", () => {
    recordPnl(-500);
    const r = checkAll(makeSignal());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("daily_drawdown_exceeded");
  });
  it("records PnL into weekly Sharpe", () => {
    recordPnl(10);
    recordPnl(20);
    recordPnl(30);
    const s = weeklySharpe();
    expect(s).toBeGreaterThan(0);
  });
  it("getState() reflects current state", () => {
    recordFill("buy", 50);
    recordPnl(5);
    const st = getState();
    expect(st.openPositions).toBe(1);
    expect(st.intradayPnl).toBe(5);
  });
});
