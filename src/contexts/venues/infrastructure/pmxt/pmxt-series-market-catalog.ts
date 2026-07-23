export interface PmxtSeriesCatalogClient {
  fetchEvents(params: { series: string }): Promise<unknown[]>;
}

export interface PmxtSeriesCatalogMarket extends Record<string, unknown> {
  marketId: string;
}

export async function fetchSeriesMarketCatalog(
  client: PmxtSeriesCatalogClient,
  series: string
): Promise<PmxtSeriesCatalogMarket[]> {
  const exactSeries = series.trim();
  if (!exactSeries) {
    throw new Error("PMXT series is required");
  }
  const events = await client.fetchEvents({ series: exactSeries });
  if (!Array.isArray(events)) {
    throw new Error("PMXT series events response is malformed");
  }

  const markets: PmxtSeriesCatalogMarket[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || !Array.isArray(event.markets)) {
      const eventId = isRecord(event) && typeof event.id === "string" ? event.id : "unknown";
      throw new Error(`PMXT event ${eventId} has malformed markets`);
    }
    for (const market of event.markets) {
      if (!isRecord(market) || typeof market.marketId !== "string" || market.marketId.trim().length === 0) {
        throw new Error("PMXT series market is missing marketId");
      }
      const marketId = market.marketId.trim();
      if (!seen.has(marketId)) {
        seen.add(marketId);
        markets.push(market as PmxtSeriesCatalogMarket);
      }
    }
  }
  return markets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
