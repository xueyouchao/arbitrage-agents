/**
 * Edge detector: compares fair probability to market mid and emits a Signal
 * when the edge exceeds the configured threshold. Enforces the time-in-window
 * gate (only act when τ/T < cfg.tauFracGate, i.e. mid-candle onward) to avoid
 * entering too early when the price hasn't moved yet.
 */
import type { CandleSnapshot } from "./candle.js";
import type { BookState } from "../feeds/polymarket.js";
import { cfg } from "../config.js";
import { fairUpProb } from "./model.js";

export type Side = "up" | "down";

export interface Signal {
  conditionId: string;
  side: Side;
  fair: number; // 0..1
  market: number; // 0..1 (mid)
  edge: number; // fair - market (positive = buy)
  tauSec: number;
  sigma: number;
  asset: BookState["market"]["asset"];
  horizon: BookState["market"]["horizon"];
  reason: string;
}

export function detectEdge(candle: CandleSnapshot, book: BookState): Signal | null {
  if (candle.symbol !== assetToBinanceSymbol(book.market.asset)) {
    const want = assetToBinanceSymbol(book.market.asset);
    if (candle.symbol !== want) return null;
  }
  const tauFrac = candle.tauSec / candle.Tsec;
  if (tauFrac > cfg.tauFracGate) {
    return null; // too early in the window
  }
  if (candle.realizedVol60s < cfg.volFloor15m) {
    return null; // too quiet — risk of whipsaw
  }
  const fair = fairUpProb({ candle });
  const upEdge = fair.pUp - book.upMid;
  const downEdge = 1 - fair.pUp - book.downMid;
  if (upEdge > cfg.edgeThreshold && upEdge >= downEdge) {
    return {
      conditionId: book.market.conditionId,
      side: "up",
      fair: fair.pUp,
      market: book.upMid,
      edge: upEdge,
      tauSec: candle.tauSec,
      sigma: fair.sigma,
      asset: book.market.asset,
      horizon: book.market.horizon,
      reason: `fairUp=${fair.pUp.toFixed(3)} vs market=${book.upMid.toFixed(3)}; tauFrac=${tauFrac.toFixed(2)}`,
    };
  }
  if (downEdge > cfg.edgeThreshold && downEdge > upEdge) {
    return {
      conditionId: book.market.conditionId,
      side: "down",
      fair: 1 - fair.pUp,
      market: book.downMid,
      edge: downEdge,
      tauSec: candle.tauSec,
      sigma: fair.sigma,
      asset: book.market.asset,
      horizon: book.market.horizon,
      reason: `fairDown=${(1 - fair.pUp).toFixed(3)} vs market=${book.downMid.toFixed(3)}; tauFrac=${tauFrac.toFixed(2)}`,
    };
  }
  return null;
}

function assetToBinanceSymbol(a: BookState["market"]["asset"]): "BTCUSDT" | "ETHUSDT" | "SOLUSDT" {
  if (a === "BTC") return "BTCUSDT";
  if (a === "ETH") return "ETHUSDT";
  return "SOLUSDT";
}
