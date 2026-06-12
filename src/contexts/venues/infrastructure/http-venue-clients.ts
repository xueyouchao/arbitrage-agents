import { MarketBook, PriceLevel } from "../../arbitrage/domain/opportunity";
import { VenueClient, VenueMarketSnapshot } from "../domain/venue-market";

interface PublicHttpOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

const DEFAULT_HTTP_OPTIONS: Required<PublicHttpOptions> = {
  timeoutMs: 5_000,
  retries: 2,
  retryDelayMs: 100
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
    return Promise.all(markets.map((market) => this.listOrderbook(market)));
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
    const books = await Promise.all(markets.map((market) => this.listOrderbook(market)));
    return books.filter((book): book is MarketBook => book !== undefined);
  }

  private async listOrderbook(market: VenueMarketSnapshot): Promise<MarketBook | undefined> {
    const tokenIds = extractPolymarketTokenIds(market.rawPayload);
    if (!tokenIds?.yes || !tokenIds.no) return undefined;

    const [yesBook, noBook] = await Promise.all([
      fetchPublicJson<Record<string, unknown>>(
        `${this.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenIds.yes)}`,
        `Polymarket YES orderbook ${market.venueMarketId}`,
        this.httpOptions
      ),
      fetchPublicJson<Record<string, unknown>>(
        `${this.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenIds.no)}`,
        `Polymarket NO orderbook ${market.venueMarketId}`,
        this.httpOptions
      )
    ]);
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
  let lastError: unknown;

  for (let attempt = 0; attempt <= mergedOptions.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), mergedOptions.timeoutMs);
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      if (response.ok) return (await response.json()) as T;
      if (!isRetryableStatus(response.status)) throw new Error(`${label} failed: ${response.status}`);
      lastError = new Error(`${label} failed: ${response.status}`);
    } catch (error) {
      lastError = error;
      if (isNonRetryableHttpError(error) || attempt === mergedOptions.retries) break;
    } finally {
      clearTimeout(timeout);
    }
    await delay(mergedOptions.retryDelayMs * 2 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isNonRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = Number(error.message.match(/failed: (\d{3})$/)?.[1]);
  return Number.isFinite(status) && !isRetryableStatus(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
