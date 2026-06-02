/**
 * Polymarket CLOB market discovery. Discovers the active 15-min/1h BTC/ETH/SOL
 * "Up or Down" markets, fetches the current order-book mid, and pushes into
 * a ring buffer keyed by `conditionId`.
 *
 * In paper mode, this still subscribes to the public market channel (read-only)
 * so signal logic runs against realistic book dynamics. Live mode additionally
 * submits orders via `exec/polymarket.ts`.
 */
import WebSocket from "ws";
import { cfg } from "../config.js";
import { log } from "../infra/logger.js";
import { httpJson } from "../infra/http.js";

export interface Market {
  conditionId: string;
  question: string;
  upTokenId: string;
  downTokenId: string;
  endTime: number; // ms epoch
  strike: number; // open price of underlying for this market
  asset: "BTC" | "ETH" | "SOL";
  horizon: "15m" | "1h";
}

export interface BookState {
  market: Market;
  upMid: number; // 0..1
  downMid: number;
  upBestBid: number;
  upBestAsk: number;
  lastUpdate: number;
}

const books = new Map<string, BookState>();
let ws: WebSocket | null = null;
let pollTimer: NodeJS.Timeout | null = null;

export function listBooks(): BookState[] {
  return Array.from(books.values());
}
export function getBook(conditionId: string): BookState | undefined {
  return books.get(conditionId);
}

/**
 * Discover active crypto "Up or Down" markets via the public Gamma API.
 * We don't depend on any auth here — the response is a paginated list of
 * active markets filtered by tag.
 */
async function discoverMarkets(): Promise<Market[]> {
  const url = `${cfg.polymarketClobUrl}/markets?active=true&closed=false&limit=50&tag=crypto`;
  try {
    const data = await httpJson<any>(url, {}, { timeoutMs: 5000, retries: 1 });
    const out: Market[] = [];
    for (const m of data?.data ?? []) {
      // Best-effort parsing — Polymarket schemas evolve; degrade gracefully.
      const q = String(m.question ?? "").toLowerCase();
      let asset: Market["asset"] | null = null;
      if (q.includes("bitcoin") || q.includes("btc")) asset = "BTC";
      else if (q.includes("ethereum") || q.includes("eth")) asset = "ETH";
      else if (q.includes("solana") || q.includes("sol")) asset = "SOL";
      if (!asset) continue;
      const horizon: Market["horizon"] = q.includes("15") ? "15m" : "1h";
      const endTime = m.end_date_iso ? Date.parse(m.end_date_iso) : Date.now() + 3600_000;
      out.push({
        conditionId: String(m.condition_id ?? m.conditionId ?? ""),
        question: String(m.question ?? ""),
        upTokenId: String(m.tokens?.[0]?.token_id ?? ""),
        downTokenId: String(m.tokens?.[1]?.token_id ?? ""),
        endTime,
        strike: Number(m.strike_price ?? 0),
        asset,
        horizon,
      });
    }
    return out;
  } catch (e) {
    log.warn("polymarket.discover.fail", { err: String(e) });
    return [];
  }
}

/**
 * Subscribe to the public market channel. We use a JSON-RPC subscribe message
 * keyed by `assets_ids` (Polymarket's token IDs). The book stream is noisy —
 * we only retain the latest snapshot per condition.
 */
function startWs(markets: Market[]) {
  if (ws) return;
  if (markets.length === 0) return;
  log.info("polymarket.ws.connect", { n: markets.length });
  ws = new WebSocket(cfg.polymarketWsUrl);
  ws.on("open", () => {
    log.info("polymarket.ws.open");
    ws?.send(
      JSON.stringify({
        type: "market",
        assets_ids: markets.map((m) => [m.upTokenId, m.downTokenId]).flat(),
      }),
    );
  });
  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return;
    }
    const asset = String(msg.asset_id ?? "");
    const book = msg.book;
    if (!asset || !book) return;
    const mid = computeMid(book);
    for (const b of books.values()) {
      if (b.market.upTokenId === asset || b.market.downTokenId === asset) {
        if (b.market.upTokenId === asset) b.upMid = mid;
        if (b.market.downTokenId === asset) b.downMid = mid;
        b.lastUpdate = Date.now();
        const bb = bestBid(book);
        const ba = bestAsk(book);
        if (b.market.upTokenId === asset) {
          b.upBestBid = bb;
          b.upBestAsk = ba;
        }
      }
    }
  });
  ws.on("close", () => {
    log.warn("polymarket.ws.close");
    ws = null;
  });
  ws.on("error", (e) => log.error("polymarket.ws.error", { msg: String(e) }));
}

function computeMid(book: any): number {
  const bb = bestBid(book);
  const ba = bestAsk(book);
  if (bb > 0 && ba > 0) return (bb + ba) / 2;
  return 0.5;
}
function bestBid(book: any): number {
  const bids = book?.bids;
  if (!Array.isArray(bids) || bids.length === 0) return 0;
  return Math.max(...bids.map((b: any) => Number(b.price ?? 0)));
}
function bestAsk(book: any): number {
  const asks = book?.asks;
  if (!Array.isArray(asks) || asks.length === 0) return 0;
  return Math.min(...asks.map((a: any) => Number(a.price ?? Infinity)));
}

export async function startPolymarket(): Promise<void> {
  if (books.size > 0) return; // already running
  const markets = await discoverMarkets();
  for (const m of markets) {
    if (!m.conditionId || !m.upTokenId) continue;
    books.set(m.conditionId, {
      market: m,
      upMid: 0.5,
      downMid: 0.5,
      upBestBid: 0,
      upBestAsk: 0,
      lastUpdate: Date.now(),
    });
  }
  log.info("polymarket.discover.done", { n: books.size });
  startWs(markets);

  // Re-discover every 5 min in case new markets appear.
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const fresh = await discoverMarkets();
    for (const m of fresh) {
      if (!books.has(m.conditionId) && m.conditionId && m.upTokenId) {
        books.set(m.conditionId, {
          market: m,
          upMid: 0.5,
          downMid: 0.5,
          upBestBid: 0,
          upBestAsk: 0,
          lastUpdate: Date.now(),
        });
      }
    }
  }, 5 * 60_000);
}

export function stopPolymarket(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
