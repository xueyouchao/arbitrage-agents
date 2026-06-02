/**
 * Coinbase Exchange public WebSocket: matches + ticker channels for BTC/ETH/SOL.
 *
 * Mirrors `feeds/binance.ts` but for Coinbase's protocol. Used for cross-venue
 * confirmation — when Binance and Coinbase both confirm a move, the signal
 * confidence is higher.
 */
import WebSocket from "ws";
import { cfg } from "../config.js";
import { log } from "../infra/logger.js";

export type Symbol = "BTC-USD" | "ETH-USD" | "SOL-USD";
const SYMBOLS: Symbol[] = ["BTC-USD", "ETH-USD", "SOL-USD"];

interface BufferState {
  last: number;
  lastTs: number;
  bestBid: number;
  bestAsk: number;
  updates: number;
}

const state = new Map<Symbol, BufferState>(
  SYMBOLS.map((s) => [s, { last: 0, lastTs: 0, bestBid: 0, bestAsk: 0, updates: 0 }]),
);

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function handleMessage(raw: string | Buffer) {
  let msg: any;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return;
  }
  const buf = state.get(msg.product_id as Symbol);
  if (!buf) return;
  if (msg.type === "match" || msg.type === "ticker") {
    if (msg.price) {
      buf.last = Number(msg.price);
      buf.lastTs = msg.time ? Date.parse(msg.time) : Date.now();
      buf.updates++;
    }
    if (msg.best_bid) buf.bestBid = Number(msg.best_bid);
    if (msg.best_ask) buf.bestAsk = Number(msg.best_ask);
  }
}

export function lastPrice(s: Symbol): number {
  return state.get(s)?.last ?? 0;
}
export function bestBidAsk(s: Symbol): { bid: number; ask: number } {
  const b = state.get(s);
  return { bid: b?.bestBid ?? 0, ask: b?.bestAsk ?? 0 };
}
export function updates(s: Symbol): number {
  return state.get(s)?.updates ?? 0;
}

export function startCoinbase(): void {
  if (ws) return;
  log.info("coinbase.connect");
  ws = new WebSocket(cfg.coinbaseWs);
  ws.on("open", () => {
    log.info("coinbase.open");
    ws?.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: SYMBOLS,
        channels: ["matches", "ticker"],
      }),
    );
  });
  ws.on("message", (data) => handleMessage(data as Buffer));
  ws.on("close", (code) => {
    log.warn("coinbase.close", { code });
    ws = null;
    scheduleReconnect();
  });
  ws.on("error", (e) => log.error("coinbase.error", { msg: String(e) }));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startCoinbase();
  }, 1500);
}

export function stopCoinbase(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
