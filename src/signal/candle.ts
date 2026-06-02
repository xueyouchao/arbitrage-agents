/**
 * Per-asset candle tracker. Maintains the open price of the current window
 * (e.g. the 1h candle that started at the top of the hour) and an EWMA of
 * realized volatility over the last 60s. Pure functions, no I/O.
 *
 * The hot path (orchestrator/tick.ts) calls `tick()` on every price update;
 * the model layer reads the latest snapshot via `snapshot()`.
 */
import type { Symbol } from "../feeds/binance.js";

export interface CandleSnapshot {
  symbol: Symbol;
  windowStart: number; // ms epoch
  open: number;
  current: number;
  tauSec: number; // time-to-expiry in seconds
  Tsec: number; // total window length in seconds
  realizedVol60s: number; // annualized, 0..~2
}

interface State {
  open: number;
  windowStart: number;
  Tsec: number;
  prices: Array<{ t: number; p: number }>; // last 60s
}

const state = new Map<Symbol, State>();

const WINDOWS: Record<Symbol, number> = {
  BTCUSDT: 3600, // 1h default; for 15m we'd parameterize further
  ETHUSDT: 3600,
  SOLUSDT: 3600,
};

function startNewWindow(s: Symbol, now: number, price: number) {
  const T = WINDOWS[s];
  state.set(s, { open: price, windowStart: now, Tsec: T, prices: [{ t: now, p: price }] });
}

export function tick(s: Symbol, now: number, price: number) {
  const st = state.get(s);
  if (!st) {
    startNewWindow(s, now, price);
    return;
  }
  if (now - st.windowStart >= st.Tsec * 1000) {
    startNewWindow(s, now, price);
    return;
  }
  st.prices.push({ t: now, p: price });
  // Trim to last 60s
  const cutoff = now - 60_000;
  while (st.prices.length > 0 && st.prices[0]!.t < cutoff) st.prices.shift();
}

export function snapshot(s: Symbol, now: number, currentPrice: number): CandleSnapshot | null {
  const st = state.get(s);
  if (!st) return null;
  const tau = Math.max(0, (st.windowStart + st.Tsec * 1000 - now) / 1000);
  return {
    symbol: s,
    windowStart: st.windowStart,
    open: st.open,
    current: currentPrice,
    tauSec: tau,
    Tsec: st.Tsec,
    realizedVol60s: realizedVol(st.prices),
  };
}

function realizedVol(samples: Array<{ t: number; p: number }>): number {
  if (samples.length < 3) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!.p;
    const b = samples[i]!.p;
    if (a > 0 && b > 0) logReturns.push(Math.log(b / a));
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance = logReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / (logReturns.length - 1);
  const SEC_PER_YEAR = 365.25 * 24 * 3600;
  return Math.sqrt(variance) * Math.sqrt(SEC_PER_YEAR);
}
