import { describe, it, expect } from "vitest";
import { detectEdge } from "../src/signal/edge.js";
import type { CandleSnapshot } from "../src/signal/candle.js";
import type { BookState } from "../src/feeds/polymarket.js";

function makeCandle(overrides: Partial<CandleSnapshot> = {}): CandleSnapshot {
  return {
    symbol: "BTCUSDT",
    windowStart: Date.now() - 3000_000,
    open: 67000,
    current: 67500,
    tauSec: 600,
    Tsec: 3600,
    realizedVol60s: 0.5,
    ...overrides,
  };
}

function makeBook(overrides: Partial<BookState> = {}): BookState {
  return {
    market: {
      conditionId: "0xtest",
      question: "Will BTC be up at 4pm ET?",
      upTokenId: "0xup",
      downTokenId: "0xdown",
      endTime: Date.now() + 600_000,
      strike: 67000,
      asset: "BTC",
      horizon: "1h",
    },
    upMid: 0.55,
    downMid: 0.45,
    upBestBid: 0.54,
    upBestAsk: 0.56,
    lastUpdate: Date.now(),
    ...overrides,
  };
}

describe("detectEdge()", () => {
  it("returns null when tauFrac > gate (early in window)", () => {
    const c = makeCandle({ tauSec: 3000, Tsec: 3600 });
    const b = makeBook();
    expect(detectEdge(c, b)).toBeNull();
  });
  it("returns null when vol is below floor", () => {
    const c = makeCandle({ realizedVol60s: 0.001, tauSec: 600 });
    const b = makeBook();
    expect(detectEdge(c, b)).toBeNull();
  });
  it("emits an UP signal when fair >> market", () => {
    const c = makeCandle({ current: 70000, tauSec: 600, realizedVol60s: 0.6 });
    const b = makeBook({ upMid: 0.55 });
    const sig = detectEdge(c, b);
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe("up");
    expect(sig!.edge).toBeGreaterThan(0);
  });
  it("emits a DOWN signal when fair << market", () => {
    const c = makeCandle({ current: 65000, tauSec: 600, realizedVol60s: 0.6 });
    const b = makeBook({ upMid: 0.55, downMid: 0.45 });
    const sig = detectEdge(c, b);
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe("down");
  });
  it("returns null when both edges are below threshold", () => {
    // When current = open, fair ≈ 0.5, so set market ≈ 0.5 too.
    const c = makeCandle({ current: 67000, tauSec: 5, realizedVol60s: 0.5 });
    const b = makeBook({ upMid: 0.5, downMid: 0.5 });
    expect(detectEdge(c, b)).toBeNull();
  });
});
