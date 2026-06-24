import { MarketBook, PriceLevel } from "../../arbitrage/domain/opportunity";
import { VenueClient, VenueMarketSnapshot } from "../domain/venue-market";

interface PublicHttpOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  concurrency?: number;
  jitter?: () => number;
}

const DEFAULT_HTTP_OPTIONS: Required<PublicHttpOptions> = {
  // Keep the per-attempt timeout bounded: with retries:3 the worst case for a
  // single hung request is 4 × 10s plus backoff. This limits the chance that
  // a degraded endpoint pushes an entire scan past the abandoned threshold.
  timeoutMs: 10_000,
  retries: 3,
  retryDelayMs: 500,
  concurrency: 1,
  jitter: Math.random
};

export class KalshiPublicVenueClient implements VenueClient {
  constructor(
    private readonly baseUrl = "https://external-api.kalshi.com/trade-api/v2",
    private readonly httpOptions: PublicHttpOptions = {}
  ) {}

  async listMarkets(): Promise<VenueMarketSnapshot[]> {
    const body = await fetchPublicJson<{ markets?: Array<Record<string, unknown>> }>(
      `${this.baseUrl}/markets?status=open&limit=100`,
      "Kalshi markets",
      this.httpOptions
    );
    const capturedAt = new Date().toISOString();
    return (body.markets ?? []).map((market) => ({
      venue: "kalshi" as const,
      venueMarketId: String(market.ticker ?? market.id ?? market.market_ticker),
      title: String(market.title ?? market.subtitle ?? market.ticker ?? ""),
      rawResolutionText: String(market.rules_primary ?? market.settlement_sources ?? market.title ?? ""),
      rawPayload: market,
      capturedAt
    }));
  }

  async listOrderbooks(markets: VenueMarketSnapshot[]): Promise<MarketBook[]> {
    return mapWithConcurrency(markets, (market) => this.listOrderbook(market), this.httpOptions.concurrency ?? DEFAULT_HTTP_OPTIONS.concurrency);
  }

  private async listOrderbook(market: VenueMarketSnapshot): Promise<MarketBook> {
    const body = await fetchPublicJson<Record<string, unknown>>(
      `${this.baseUrl}/markets/${encodeURIComponent(market.venueMarketId)}/orderbook`,
      `Kalshi orderbook ${market.venueMarketId}`,
      this.httpOptions
    );
    const orderbook = getObject(body.orderbook_fp) ?? getObject(body.orderbook) ?? body;
    const yesBids = parseLevels(orderbook.yes_dollars ?? orderbook.yes);
    const noBids = parseLevels(orderbook.no_dollars ?? orderbook.no);
    const bestYesBid = bestBid(yesBids);
    const bestNoBid = bestBid(noBids);
    const yesDepth = yesAskDepthFromNoBids(noBids);
    const noDepth = noAskDepthFromYesBids(yesBids);
    const yesAsk = yesDepth[0]?.price ?? 1;
    const noAsk = noDepth[0]?.price ?? 1;

    return {
      marketId: market.venueMarketId,
      venue: "kalshi",
      yesAsk,
      noAsk,
      yesAvailableUsd: yesDepth[0] ? roundUsd(yesDepth[0].price * yesDepth[0].size) : 0,
      noAvailableUsd: noDepth[0] ? roundUsd(noDepth[0].price * noDepth[0].size) : 0,
      yesDepth,
      noDepth,
      capturedAt: new Date().toISOString(),
      stale: !bestYesBid || !bestNoBid,
      rawPayload: body
    };
  }
}

export class PolymarketPublicVenueClient implements VenueClient {
  constructor(
    private readonly baseUrl = "https://gamma-api.polymarket.com",
    private readonly clobBaseUrl = "https://clob.polymarket.com",
    private readonly httpOptions: PublicHttpOptions = {}
  ) {}

  async listMarkets(): Promise<VenueMarketSnapshot[]> {
    const markets = await fetchPublicJson<Array<Record<string, unknown>>>(
      `${this.baseUrl}/markets?closed=false&limit=100`,
      "Polymarket markets",
      this.httpOptions
    );
    const capturedAt = new Date().toISOString();
    return markets.map((market) => ({
      venue: "polymarket" as const,
      venueMarketId: String(market.conditionId ?? market.id),
      title: String(market.question ?? market.title ?? ""),
      rawResolutionText: String(market.resolutionSource ?? market.description ?? market.question ?? ""),
      rawPayload: market,
      capturedAt
    }));
  }

  async listOrderbooks(markets: VenueMarketSnapshot[]): Promise<MarketBook[]> {
    const tasks = this.buildBookSideTasks(markets);
    if (tasks.length === 0) return [];

    const concurrency = this.httpOptions.concurrency ?? DEFAULT_HTTP_OPTIONS.concurrency;
    // Schedule individual /book fetches so the concurrency cap applies to the
    // actual HTTP request pressure, not to the number of markets. Each market
    // still requires both YES and NO sides, but the operator-configured
    // concurrency value is now the total in-flight fetch ceiling.
    const sides = await mapWithConcurrency(tasks, (task) => this.fetchBookSide(task), concurrency);

    const yesByMarket = new Map<string, Record<string, unknown>>();
    const noByMarket = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      if (task.side === "yes") yesByMarket.set(task.market.venueMarketId, sides[i]);
      else noByMarket.set(task.market.venueMarketId, sides[i]);
    }

    const books: MarketBook[] = [];
    for (const market of markets) {
      const yesBook = yesByMarket.get(market.venueMarketId);
      const noBook = noByMarket.get(market.venueMarketId);
      if (yesBook && noBook) books.push(this.buildBook(market, yesBook, noBook));
    }
    return books;
  }

  private buildBookSideTasks(
    markets: VenueMarketSnapshot[]
  ): { market: VenueMarketSnapshot; side: "yes" | "no"; tokenId: string }[] {
    const tasks: { market: VenueMarketSnapshot; side: "yes" | "no"; tokenId: string }[] = [];
    for (const market of markets) {
      const tokenIds = extractPolymarketTokenIds(market.rawPayload);
      if (!tokenIds?.yes || !tokenIds.no) continue;
      tasks.push({ market, side: "yes", tokenId: tokenIds.yes });
      tasks.push({ market, side: "no", tokenId: tokenIds.no });
    }
    return tasks;
  }

  private async fetchBookSide(
    task: { market: VenueMarketSnapshot; side: "yes" | "no"; tokenId: string }
  ): Promise<Record<string, unknown>> {
    return fetchPublicJson<Record<string, unknown>>(
      `${this.clobBaseUrl}/book?token_id=${encodeURIComponent(task.tokenId)}`,
      `Polymarket ${task.side.toUpperCase()} orderbook ${task.market.venueMarketId}`,
      this.httpOptions
    );
  }

  private buildBook(
    market: VenueMarketSnapshot,
    yesBook: Record<string, unknown>,
    noBook: Record<string, unknown>
  ): MarketBook {
    const yesDepth = parseObjectLevels(yesBook.asks).sort((a, b) => a.price - b.price);
    const noDepth = parseObjectLevels(noBook.asks).sort((a, b) => a.price - b.price);
    const yesAskLevel = bestAsk(yesDepth);
    const noAskLevel = bestAsk(noDepth);

    return {
      marketId: market.venueMarketId,
      venue: "polymarket",
      yesAsk: yesAskLevel?.price ?? 1,
      noAsk: noAskLevel?.price ?? 1,
      yesAvailableUsd: yesAskLevel ? roundUsd(yesAskLevel.price * yesAskLevel.size) : 0,
      noAvailableUsd: noAskLevel ? roundUsd(noAskLevel.price * noAskLevel.size) : 0,
      yesDepth,
      noDepth,
      capturedAt: new Date().toISOString(),
      stale: !yesAskLevel || !noAskLevel,
      rawPayload: { yesBook, noBook }
    };
  }
}

async function fetchPublicJson<T>(url: string, label: string, options: PublicHttpOptions): Promise<T> {
  const mergedOptions = { ...DEFAULT_HTTP_OPTIONS, ...options };
  const jitter = mergedOptions.jitter;
  let lastError: unknown;
  let totalBackoffMs = 0;
  let attemptsMade = 0;

  for (let attempt = 0; attempt <= mergedOptions.retries; attempt += 1) {
    attemptsMade = attempt + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), mergedOptions.timeoutMs);
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      if (response.ok) return (await response.json()) as T;
      if (!isRetryableStatus(response.status)) {
        lastError = new Error(`${label} failed: ${response.status}`);
        break;
      }
      lastError = new Error(`${label} failed: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (isNonRetryableHttpError(error) || attempt === mergedOptions.retries) break;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < mergedOptions.retries) {
      const delayMs = Math.round(mergedOptions.retryDelayMs * 2 ** attempt * (0.75 + jitter() * 0.5));
      totalBackoffMs += delayMs;
      await delay(delayMs);
    }
  }

  throw formatFetchError(label, lastError, attemptsMade, totalBackoffMs);
}

function formatFetchError(label: string, lastError: unknown, attempts: number, totalBackoffMs: number): Error {
  const suffix = ` after ${attempts} attempt${attempts === 1 ? "" : "s"} (total backoff ${totalBackoffMs}ms)`;
  if (lastError instanceof Error) {
    if (lastError.message.includes(label)) {
      return new Error(`${lastError.message}${suffix}`);
    }
    return new Error(`${label} failed: ${lastError.message}${suffix}`);
  }
  return new Error(`${label} failed${suffix}`);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isNonRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = Number(error.message.match(/failed: (\d{3})(?: after |$)/)?.[1]);
  return Number.isFinite(status) && !isRetryableStatus(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  if (concurrency <= 0) throw new Error("concurrency must be positive");
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let index = 0;
  let running = 0;
  let resolved = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    function startNext(): void {
      if (settled) return;
      while (running < concurrency && index < items.length) {
        const currentIndex = index++;
        running += 1;
        mapper(items[currentIndex], currentIndex)
          .then(
            (value) => {
              results[currentIndex] = value;
            },
            (error) => {
              settled = true;
              reject(error);
            }
          )
          .finally(() => {
            if (settled) return;
            running -= 1;
            resolved += 1;
            if (resolved === items.length) {
              resolve(results);
            } else {
              startNext();
            }
          });
      }
    }
    startNext();
  });
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((level) => {
    if (!Array.isArray(level) || level.length < 2) return [];
    const price = normalizePrice(Number(level[0]));
    const size = Number(level[1]);
    return isValidLevel(price, size) ? [{ price, size }] : [];
  });
}

function parseObjectLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((level) => {
    const object = getObject(level);
    if (!object) return [];
    const price = normalizePrice(Number(object.price));
    const size = Number(object.size);
    return isValidLevel(price, size) ? [{ price, size }] : [];
  });
}

function normalizePrice(price: number): number {
  return price > 1 ? price / 100 : price;
}

function isValidLevel(price: number, size: number): boolean {
  return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0;
}

function bestBid(levels: PriceLevel[]): PriceLevel | undefined {
  return levels.reduce<PriceLevel | undefined>((best, level) => (!best || level.price > best.price ? level : best), undefined);
}

function bestAsk(levels: PriceLevel[]): PriceLevel | undefined {
  return levels.reduce<PriceLevel | undefined>((best, level) => (!best || level.price < best.price ? level : best), undefined);
}

function yesAskDepthFromNoBids(noBids: PriceLevel[]): PriceLevel[] {
  return noBids
    .map((level) => ({ price: roundPrice(1 - level.price), size: level.size }))
    .filter((level) => isValidLevel(level.price, level.size))
    .sort((a, b) => a.price - b.price);
}

function noAskDepthFromYesBids(yesBids: PriceLevel[]): PriceLevel[] {
  return yesBids
    .map((level) => ({ price: roundPrice(1 - level.price), size: level.size }))
    .filter((level) => isValidLevel(level.price, level.size))
    .sort((a, b) => a.price - b.price);
}

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function extractPolymarketTokenIds(payload: Record<string, unknown>): { yes?: string; no?: string } | undefined {
  const ids = parseStringArray(payload.clobTokenIds ?? payload.clob_token_ids ?? payload.tokenIds ?? payload.token_ids);
  if (ids.length < 2) return undefined;

  const outcomes = parseStringArray(payload.outcomes);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");

  return {
    yes: ids[yesIndex >= 0 ? yesIndex : 0],
    no: ids[noIndex >= 0 ? noIndex : 1]
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_error) {
    return [];
  }
}
