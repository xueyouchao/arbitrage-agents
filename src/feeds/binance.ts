/**
 * Binance public WebSocket: aggTrade + bookTicker streams for BTC/ETH/SOL.
 *
 * Pattern: subscribe to multi-stream URL, parse frames, push to a per-symbol
 * ring buffer keyed by symbol. Hot path reads `lastPrice(symbol)` — never
 * awaits the WebSocket.
 *
 * Latency target: <50ms from WS frame to ring buffer update.
 */
import WebSocket from "ws";
import { cfg } from "../config.js";
import { log } from "../infra/logger.js";

export type Symbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";

const SYMBOLS: Symbol[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

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
let startedAt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function buildUrl(): string {
  const streams = SYMBOLS.flatMap((s) => [
    `${s.toLowerCase()}@aggTrade`,
    `${s.toLowerCase()}@bookTicker`,
  ]).join("/");
  return `${cfg.binanceWs}/?streams=${streams}`;
}

function handleMessage(raw: string | Buffer) {
  let msg: any;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return;
  }
  if (!msg.data) return;
  const d = msg.data;
  const s = d.s as Symbol | undefined;
  if (!s) return;
  const buf = state.get(s);
  if (!buf) return;

  if (d.e === "aggTrade") {
    buf.last = Number(d.p);
    buf.lastTs = d.T;
    buf.updates++;
  } else if (d.e === "bookTicker" || (d.b && d.a)) {
    buf.bestBid = Number(d.b);
    buf.bestAsk = Number(d.a);
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
export function startedAgo(): number {
  return startedAt ? Date.now() - startedAt : 0;
}

export function startBinance(): void {
  if (ws) return;
  startedAt = Date.now();
  const url = buildUrl();
  log.info("binance.connect", { url });
  ws = new WebSocket(url);
  ws.on("open", () => log.info("binance.open"));
  ws.on("message", (data) => handleMessage(data as Buffer));
  ws.on("close", (code) => {
    log.warn("binance.close", { code });
    ws = null;
    scheduleReconnect();
  });
  ws.on("error", (e) => log.error("binance.error", { msg: String(e) }));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBinance();
  }, 1500);
}

export function stopBinance(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
