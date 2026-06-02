/**
 * Hot loop: runs every TICK_MS milliseconds. Reads the latest Binance/Coinbase
 * prices, updates the candle tracker, scans Polymarket books for edge, runs
 * risk gates, and (in paper mode) simulates a fill. Logs latency per tick.
 *
 * No LLM calls in this file — by design. The hot path must be deterministic
 * and bounded.
 */
import { lastPrice as bLast, type Symbol as BSymbol } from "../feeds/binance.js";
import { lastPrice as cLast, type Symbol as CSymbol } from "../feeds/coinbase.js";
import { listBooks, getBook } from "../feeds/polymarket.js";
import { tick as candleTick, snapshot } from "../signal/candle.js";
import { detectEdge, type Signal } from "../signal/edge.js";
import { checkAll, recordFill } from "../risk/gates.js";
import { paperFill } from "../paper/runner.js";
import { log } from "../infra/logger.js";

const TICK_MS = 500;

let lastRegimeAt = 0;

export async function tickOnce(): Promise<{ signal: Signal | null; acted: boolean }> {
  const now = Date.now();
  const symbols: BSymbol[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  for (const s of symbols) {
    const p = bLast(s);
    if (p > 0) candleTick(s, now, p);
  }

  let acted = false;
  let chosenSignal: Signal | null = null;
  for (const book of listBooks()) {
    if (now >= book.market.endTime) continue;
    const asset = book.market.asset;
    const bs: BSymbol = asset === "BTC" ? "BTCUSDT" : asset === "ETH" ? "ETHUSDT" : "SOLUSDT";
    const cs: CSymbol = asset === "BTC" ? "BTC-USD" : asset === "ETH" ? "ETH-USD" : "SOL-USD";
    const priceB = bLast(bs);
    const priceC = cLast(cs);
    const price = priceB > 0 ? priceB : priceC;
    if (price <= 0) continue;
    const c = snapshot(bs, now, price);
    if (!c) continue;
    const sig = detectEdge(c, book);
    if (!sig) continue;
    chosenSignal = sig;
    const gate = checkAll(sig);
    if (!gate.ok) {
      log.debug("tick.gate_block", { reason: gate.reason, edge: sig.edge });
      continue;
    }
    const freshBook = getBook(book.market.conditionId);
    if (!freshBook) continue;
    paperFill(sig, gate.sizedUsdc!, freshBook);
    recordFill("buy", gate.sizedUsdc!);
    acted = true;
    break;
  }

  if (now - lastRegimeAt > 5 * 60_000) {
    lastRegimeAt = now;
    setTimeout(() => {
      import("../agents/regime.js")
        .then(({ classifyRegime }) => {
          const btc = snapshot("BTCUSDT", now, bLast("BTCUSDT"));
          if (!btc) return;
          return classifyRegime({
            realizedVol60s: btc.realizedVol60s,
            btcReturn15m: (btc.current - btc.open) / btc.open,
            btcReturn1h: (btc.current - btc.open) / btc.open,
            spreadBps: 5,
          });
        })
        .catch((e) => log.warn("regime.scheduled.fail", { err: String(e) }));
    }, 50);
  }

  return { signal: chosenSignal, acted };
}

export function startLoop(): () => void {
  const handle = setInterval(() => {
    const t0 = Date.now();
    tickOnce()
      .then((r) => {
        if (r.signal) {
          log.info("tick", {
            acted: r.acted,
            edge: r.signal.edge,
            side: r.signal.side,
            latencyMs: Date.now() - t0,
          });
        }
      })
      .catch((e) => log.error("tick.err", { err: String(e) }));
  }, TICK_MS);
  return () => clearInterval(handle);
}
