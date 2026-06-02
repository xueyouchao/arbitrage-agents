import { describe, it, expect } from "vitest";
import { fairUpProb, phi } from "../src/signal/model.js";
import type { CandleSnapshot } from "../src/signal/candle.js";

function makeCandle(overrides: Partial<CandleSnapshot> = {}): CandleSnapshot {
  return {
    symbol: "BTCUSDT",
    windowStart: Date.now() - 1800_000,
    open: 67000,
    current: 67200,
    tauSec: 1800,
    Tsec: 3600,
    realizedVol60s: 0.5,
    ...overrides,
  };
}

describe("phi() — standard normal CDF", () => {
  it("phi(0) ≈ 0.5", () => {
    expect(phi(0)).toBeCloseTo(0.5, 5);
  });
  it("phi(1.96) ≈ 0.975", () => {
    expect(phi(1.96)).toBeCloseTo(0.975, 3);
  });
  it("phi(-1.96) ≈ 0.025", () => {
    expect(phi(-1.96)).toBeCloseTo(0.025, 3);
  });
  it("is monotonic", () => {
    let prev = -Infinity;
    for (let x = -3; x <= 3; x += 0.5) {
      const y = phi(x);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });
});

describe("fairUpProb() — Black-Scholes binary delta", () => {
  it("spot = strike → pUp ≈ 0.5 with low vol", () => {
    const c = makeCandle({ current: 67000, open: 67000 });
    const r = fairUpProb({ candle: c });
    expect(r.pUp).toBeGreaterThan(0.4);
    expect(r.pUp).toBeLessThan(0.6);
  });
  it("spot > strike → pUp > 0.5", () => {
    const c = makeCandle({ current: 68000, open: 67000 });
    const r = fairUpProb({ candle: c });
    expect(r.pUp).toBeGreaterThan(0.5);
  });
  it("spot < strike → pUp < 0.5", () => {
    const c = makeCandle({ current: 66000, open: 67000 });
    const r = fairUpProb({ candle: c });
    expect(r.pUp).toBeLessThan(0.5);
  });
  it("pUp is clipped to [0.02, 0.98]", () => {
    const c = makeCandle({ current: 100000, open: 67000, realizedVol60s: 0.001, tauSec: 1 });
    const r = fairUpProb({ candle: c });
    expect(r.pUp).toBeLessThanOrEqual(0.98);
    expect(r.pUp).toBeGreaterThanOrEqual(0.02);
  });
  it("uses vol floor when realized vol is lower", () => {
    const low = makeCandle({ realizedVol60s: 0.01, current: 67200, open: 67000 });
    const r = fairUpProb({ candle: low });
    expect(r.sigma).toBeGreaterThanOrEqual(0.01);
  });
  it("zero spot returns neutral 0.5", () => {
    const c = makeCandle({ current: 0, open: 67000 });
    const r = fairUpProb({ candle: c });
    expect(r.pUp).toBe(0.5);
  });
});
