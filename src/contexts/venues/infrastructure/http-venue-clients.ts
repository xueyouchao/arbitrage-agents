import { MarketBook, PriceLevel } from "../../arbitrage/domain/opportunity";
import { VenueClient, VenueMarketSnapshot } from "../domain/venue-market";

interface PublicHttpOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  concurrency?: number;
  jitter?: () => number;
  /** Max markets returned per listMarkets call. Default: 100. */
  marketLimit?: number;
  /**
   * Kalshi-only: when set, listMarkets queries `GET /markets?event_ticker={eventTicker}`
   * instead of the global top-100. Use this for Kalshi events whose markets do not
   * appear in the global top-100. When set, the default limit is raised to 500 so
   * all markets under the event are returned.
   */
  eventTicker?: string;
  /**
   * Kalshi-only: when set, listMarkets queries `GET /markets?series_ticker={seriesTicker}`
   * instead of the global top-100. Use this for Kalshi series whose markets are
   * grouped by series rather than event. When set, the default limit is raised
   * to 500.
   */
  seriesTicker?: string;
  /**
   * Polymarket-only: when set, listMarkets queries `GET /events?slug={eventSlug}`
   * to get the event and its market IDs, then fetches those markets via
   * `GET /markets?closed=false&limit=500&id=...`. Use this for Polymarket events
   * whose markets do not appear in the global top-100 returned by the default
   * `/markets?closed=false&limit=100` query.
   */
  eventSlug?: string;
  /**
   * Polymarket-only: when set, listMarkets queries `GET /events?series_slug={seriesSlug}`
   * to get all events in the series and their embedded market objects. This is
   * required for recurring series such as crypto multi-strike weeklies, whose
   * markets do not appear in the global top-100.
   */
  seriesSlug?: string;
}

type ResolvedHttpOptions = Omit<Required<PublicHttpOptions>, "eventTicker" | "seriesTicker" | "eventSlug" | "seriesSlug"> & {
  eventTicker: string | undefined;
  seriesTicker: string | undefined;
  eventSlug: string | undefined;
  seriesSlug: string | undefined;
};

const DEFAULT_HTTP_OPTIONS: ResolvedHttpOptions = {
  // Keep the per-attempt timeout bounded: with retries:3 the worst case for a
  // single hung request is 4 × 10s plus backoff. This limits the chance that
  // a degraded endpoint pushes an entire scan past the abandoned threshold.
  timeoutMs: 10_000,
  retries: 3,
  retryDelayMs: 500,
  concurrency: 1,
  jitter: Math.random,
  marketLimit: 100,
  eventTicker: undefined,
  seriesTicker: undefined,
  eventSlug: undefined,
  seriesSlug: undefined,
};

export class KalshiPublicVenueClient implements VenueClient {
  constructor(
    private readonly baseUrl = "https://external-api.kalshi.com/trade-api/v2",
    private readonly httpOptions: PublicHttpOptions = {}
  ) {}

  async listMarkets(): Promise<VenueMarketSnapshot[]> {
    const limit = this.httpOptions.marketLimit
      ?? (this.httpOptions.eventTicker || this.httpOptions.seriesTicker ? 500 : DEFAULT_HTTP_OPTIONS.marketLimit);
    const eventParam = this.httpOptions.eventTicker
      ? `event_ticker=${encodeURIComponent(this.httpOptions.eventTicker)}&`
      : "";
    const seriesParam = this.httpOptions.seriesTicker
      ? `series_ticker=${encodeURIComponent(this.httpOptions.seriesTicker)}&`
      : "";
    const body = await fetchPublicJson<{ markets?: Array<Record<string, unknown>> }>(
      `${this.baseUrl}/markets?${eventParam}${seriesParam}status=open&limit=${limit}`,
      "Kalshi markets",
      this.httpOptions
    );
    const capturedAt = new Date().toISOString();
    const raw = body.markets ?? [];
    return raw.map((r) => toKalshiSnapshotFromRaw(r, capturedAt));
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
      stale: !yesDepth.length || !noDepth.length,
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
    const capturedAt = new Date().toISOString();

    let markets: Array<Record<string, unknown>>;
    if (this.httpOptions.seriesSlug) {
      markets = await this.fetchMarketsBySeriesSlug(this.httpOptions.seriesSlug);
    } else if (this.httpOptions.eventSlug) {
      markets = await this.fetchMarketsByEventSlug(this.httpOptions.eventSlug);
    } else {
      markets = await fetchPublicJson<Array<Record<string, unknown>>>(
        `${this.baseUrl}/markets?closed=false&limit=100`,
        "Polymarket markets",
        this.httpOptions
      );
    }

    return markets.map((market) => toPolymarketSnapshotFromRaw(market, capturedAt));
  }

  /**
   * Fetches all markets under a Polymarket series by slug. Queries
   * `GET /events?series_slug={seriesSlug}`; the response contains events
   * with their market objects embedded, so no extra /markets fetch is needed.
   * Series slugs are used for recurring products (crypto multi-strike weeklies,
   * sports dailies, etc.) that do not appear in the top-100 market list.
   */
  private async fetchMarketsBySeriesSlug(seriesSlug: string): Promise<Array<Record<string, unknown>>> {
    const events = await fetchPublicJson<Array<Record<string, unknown>>>(
      `${this.baseUrl}/events?series_slug=${encodeURIComponent(seriesSlug)}&active=true&closed=false&limit=100`,
      `Polymarket series ${seriesSlug}`,
      this.httpOptions
    );
    if (!Array.isArray(events)) return [];

    const markets: Array<Record<string, unknown>> = [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const eventMarkets = event.markets;
      if (!Array.isArray(eventMarkets)) continue;
      for (const m of eventMarkets) {
        if (!m || typeof m !== "object") continue;
        const market = m as Record<string, unknown>;
        market._eventTitle = event.title;
        market._eventDescription = event.description;
        market._eventEndDate = event.endDate;
        markets.push(market);
      }
    }
    return markets;
  }

  /**
   * Fetches all markets under a Polymarket event by slug. Queries
   * `GET /events?slug={eventSlug}` to get the event (which contains an
   * array of market objects with `id` fields), then fetches those markets
   * via `GET /markets?closed=false&limit=500&id=...&id=...` in batches of
   * 50 IDs to avoid exceeding URL length limits (~4-8KB).
   */
  private async fetchMarketsByEventSlug(eventSlug: string): Promise<Array<Record<string, unknown>>> {
    const events = await fetchPublicJson<Array<Record<string, unknown>>>(
      `${this.baseUrl}/events?slug=${encodeURIComponent(eventSlug)}`,
      `Polymarket event ${eventSlug}`,
      this.httpOptions
    );
    if (!Array.isArray(events)) return [];

    // Map event metadata by market id so we can merge the parent event title
    // into each market snapshot. Event-sourced match markets often have empty
    // titles and questions that don't name the opponent, so the event context
    // is required for the normalizer to resolve both sides.
    const eventByMarketId = new Map<string, Record<string, unknown>>();
    const marketIds: string[] = [];
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const eventMarkets = event.markets;
      if (!Array.isArray(eventMarkets)) continue;
      for (const m of eventMarkets) {
        if (m && typeof m === "object" && "id" in m) {
          const id = (m as Record<string, unknown>).id;
          if (id !== undefined && id !== null) {
            const idStr = String(id);
            marketIds.push(idStr);
            eventByMarketId.set(idStr, event as Record<string, unknown>);
          }
        }
      }
    }
    if (marketIds.length === 0) return [];

    // Batch market IDs to avoid URL length limits. 50 IDs per batch keeps
    // the URL well under 4KB.
    const BATCH_SIZE = 50;
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
      const batch = marketIds.slice(i, i + BATCH_SIZE);
      const idQuery = batch.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      const batchResults = await fetchPublicJson<Array<Record<string, unknown>>>(
        `${this.baseUrl}/markets?closed=false&limit=500&${idQuery}`,
        `Polymarket markets for event ${eventSlug} (batch ${Math.floor(i / BATCH_SIZE) + 1})`,
        this.httpOptions
      );
      if (!Array.isArray(batchResults)) continue;
      for (const market of batchResults) {
        const event = eventByMarketId.get(String(market.id));
        if (event) {
          market._eventTitle = event.title;
          market._eventDescription = event.description;
        }
        results.push(market);
      }
    }
    return results;
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
      rawPayload: { market: market.rawPayload, yesBook, noBook }
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

function kalshiTitle(market: Record<string, unknown>): string {
  return firstNonEmptyString(
    market.title,
    market.subtitle,
    kalshiTickerDescription(market),
    market.ticker,
    market.id
  ) ?? "";
}

function kalshiResolutionText(market: Record<string, unknown>): string {
  return firstNonEmptyString(
    market.rules_primary,
    market.settlement_sources,
    market.description,
    market.subtitle,
    kalshiSubtitlePair(market.yes_sub_title, market.no_sub_title),
    market.title,
    kalshiTickerDescription(market),
    market.ticker
  ) ?? "";
}

function toKalshiSnapshotFromRaw(
  raw: Record<string, unknown>,
  capturedAt: string
): VenueMarketSnapshot {
  // Use the full fallback chain for title and venueMarketId extraction
  return {
    venue: "kalshi",
    venueMarketId: String(raw.ticker ?? raw.id ?? raw.market_ticker ?? "unknown"),
    title: kalshiTitle(raw),
    rawResolutionText: kalshiResolutionText(raw),
    capturedAt,
    rawPayload: raw,
  };
}

/**
 * Builds a Polymarket VenueMarketSnapshot from a raw gamma API market object.
 * Event-sourced match markets often have empty titles and questions that don't
 * name the opponent, so the event context is merged into the title when it adds
 * information.
 */
function toPolymarketSnapshotFromRaw(
  raw: Record<string, unknown>,
  capturedAt: string
): VenueMarketSnapshot {
  const eventTitle = typeof raw._eventTitle === "string" && raw._eventTitle.trim().length > 0
    ? raw._eventTitle.trim()
    : undefined;
  const eventDescription = typeof raw._eventDescription === "string" && raw._eventDescription.trim().length > 0
    ? raw._eventDescription.trim()
    : undefined;
  const marketTitle = String(raw.question ?? raw.title ?? "").trim();

  // When we fetched this market via an event slug, the parent event title
  // gives essential context the market question may lack. Prepend it only
  // when it adds information.
  const title = eventTitle && !marketTitle.toLowerCase().includes(eventTitle.toLowerCase())
    ? `${eventTitle}: ${marketTitle}`
    : marketTitle;

  // Preserve the original fallback chain for non-eventSlug fetches. Only
  // prepend the parent event description when it was injected by the event-slug
  // path and adds context not already present.
  // Issue: Polymarket often returns an empty-string resolutionSource while the
  // market description contains the detailed resolution rules/source. Fall back
  // to description when resolutionSource is empty so the normalizer has the full
  // text for source/deadline/payoff parsing.
  const baseText = firstNonEmptyString(raw.resolutionSource, raw.description) ?? "";
  const baseResolutionText = eventDescription && !baseText.toLowerCase().includes(eventDescription.toLowerCase())
    ? `${eventDescription}\n${baseText}`
    : baseText;

  // Polymarket series markets (crypto daily, etc.) expose an authoritative
  // endDate in the API but describe the deadline in prose ("July 12"). Append
  // the ISO timestamp to the resolution text so parseDeadline sees it.
  // When fetched via series slug, endDate lives on the parent event and is
  // injected as _eventEndDate by fetchMarketsBySeriesSlug.
  const rawEndDate = typeof raw.endDate === "string" && raw.endDate.trim().length > 0
    ? raw.endDate.trim()
    : undefined;
  const eventEndDate = typeof raw._eventEndDate === "string" && raw._eventEndDate.trim().length > 0
    ? raw._eventEndDate.trim()
    : undefined;
  const endDate = rawEndDate ?? eventEndDate;
  const resolutionText = endDate && !baseResolutionText.includes(endDate)
    ? `${baseResolutionText}\nResolves at ${endDate}`
    : baseResolutionText;

  return {
    venue: "polymarket" as const,
    venueMarketId: String(raw.conditionId ?? raw.id),
    title,
    rawResolutionText: resolutionText,
    rawPayload: raw,
    capturedAt
  };
}

/**
 * Builds a "YES: … / NO: …" subtitle pair from Kalshi yes/no subtitle fields.
 * Issue #52: treats empty-string subtitle fields as undefined so they don't
 * produce a misleading "YES:  / NO: " pair and block fallback to other
 * resolution-text candidates. Returns undefined when both are empty/missing.
 */
function kalshiSubtitlePair(yes: unknown, no: unknown): string | undefined {
  const yesStr = typeof yes === "string" ? yes.trim() : "";
  const noStr = typeof no === "string" ? no.trim() : "";
  if (yesStr === "" && noStr === "") return undefined;
  return `YES: ${yesStr} / NO: ${noStr}`;
}

function kalshiTickerDescription(market: Record<string, unknown>): string | undefined {
  const eventTicker = market.event_ticker;
  const marketTicker = market.market_ticker;
  if (eventTicker !== undefined && marketTicker !== undefined && eventTicker !== marketTicker) {
    return `${String(eventTicker)} / ${String(marketTicker)}`;
  }
  if (eventTicker !== undefined) return String(eventTicker);
  if (marketTicker !== undefined) return String(marketTicker);
  return undefined;
}

/**
 * Returns the first non-empty (after trim) string value, or undefined if none
 * qualify. Treats empty strings the same as undefined/null (issue #52) so
 * they don't block the fallback chain.
 */
function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (str.length > 0) return str;
  }
  return undefined;
}
