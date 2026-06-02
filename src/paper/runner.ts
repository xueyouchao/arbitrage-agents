/**
 * Paper-trade executor. Mimics a Polymarket CLOB fill at the current best ask
 * (for buys) or best bid (for sells), with simulated slippage. Resolves the
 * binary contract at window end by comparing the final spot to the strike.
 *
 * The simulator is intentionally simple: no partial fills, no queue priority,
 * no realistic latency model. It's a fair approximation for backtest-grade
 * numbers, not a substitute for a real fill model.
 */
import type { BookState } from "../feeds/polymarket.js";
import type { Signal } from "../signal/edge.js";
import { log } from "../infra/logger.js";
import { recordPnl, recordFill } from "../risk/gates.js";

export interface Fill {
  signal: Signal;
  sizeUsdc: number;
  fillPrice: number; // 0..1
  side: "buy";
  tokenId: string;
  conditionId: string;
  ts: number;
  resolution?: { won: boolean; payout: number; ts: number };
}

const openFills: Fill[] = [];

export function listOpenFills(): ReadonlyArray<Fill> {
  return openFills;
}

export function paperFill(
  signal: Signal,
  sizedUsdc: number,
  book: BookState,
): Fill {
  const mid = signal.side === "up" ? book.upMid : 1 - book.upMid;
  const spread = book.upBestAsk - book.upBestBid;
  const slip = Math.max(0.001, 0.05 * Math.max(0, spread));
  const fillPrice = signal.side === "up" ? mid + slip / 2 : 1 - mid + slip / 2;
  const tokenId = signal.side === "up" ? book.market.upTokenId : book.market.downTokenId;
  const fill: Fill = {
    signal,
    sizeUsdc: sizedUsdc,
    fillPrice: Math.max(0.01, Math.min(0.99, fillPrice)),
    side: "buy",
    tokenId,
    conditionId: book.market.conditionId,
    ts: Date.now(),
  };
  openFills.push(fill);
  recordFill("buy", sizedUsdc);
  log.info("paper.fill", {
    conditionId: fill.conditionId,
    side: signal.side,
    price: fill.fillPrice,
    sizeUsdc: sizedUsdc,
    edge: signal.edge,
  });
  return fill;
}

export function resolveFill(fill: Fill, finalSpot: number, strike: number): Fill {
  const upWins = finalSpot >= strike;
  const won = (fill.signal.side === "up" && upWins) || (fill.signal.side === "down" && !upWins);
  const shares = fill.sizeUsdc / fill.fillPrice;
  const payout = won ? shares : 0;
  const pnl = payout - fill.sizeUsdc;
  fill.resolution = { won, payout, ts: Date.now() };
  recordPnl(pnl);
  const idx = openFills.indexOf(fill);
  if (idx >= 0) openFills.splice(idx, 1);
  recordFill("sell", fill.sizeUsdc);
  log.info("paper.resolve", {
    conditionId: fill.conditionId,
    side: fill.signal.side,
    won,
    pnl,
  });
  return fill;
}
