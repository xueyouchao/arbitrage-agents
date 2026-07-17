import { PmxtMarketSnapshot, mapPmxtMarketToSnapshot, PmxtMarket, outcomeIdsFor } from "./pmxt-market-mapper";
import { PmxtMarketBook, mapPmxtOrderbookToMarketBook, PmxtSdkOrderBook } from "./pmxt-orderbook-mapper";

export interface PmxtHostedVenueClientOptions {
  listMarkets(): Promise<unknown[]>;
  listOrderbooks(outcomeIds: string[]): Promise<Record<string, unknown>>;
  now?(): string;
  onDiagnostic?(message: string): void;
}

export class PmxtHostedVenueClient {
  constructor(private readonly options: PmxtHostedVenueClientOptions) {}

  async listMarkets(): Promise<PmxtMarketSnapshot[]> {
    const capturedAt = this.now();
    const raw = await this.options.listMarkets();
    const snapshots = raw.map((item) => mapPmxtMarketToSnapshot(item as PmxtMarket, capturedAt));
    this.emit(`pmxt markets=${snapshots.length}`);
    return snapshots;
  }

  async listOrderbooks(markets: PmxtMarketSnapshot[]): Promise<PmxtMarketBook[]> {
    const capturedAt = this.now();
    if (markets.length === 0) return [];
    const outcomeIds = this.extractOutcomeIds(markets);
    const rawBooks = await this.options.listOrderbooks(outcomeIds);
    const books: PmxtMarketBook[] = [];
    for (const market of markets) {
      const ids = outcomeIdsFor(market);
      const yesRaw = rawBooks[ids.yes];
      const noRaw = rawBooks[ids.no];
      if (!yesRaw || !noRaw || typeof yesRaw !== "object" || typeof noRaw !== "object") {
        throw new Error(`PMXT orderbook missing for market ${market.venueMarketId}`);
      }
      books.push(mapPmxtOrderbookToMarketBook(
        market.venueMarketId,
        yesRaw as PmxtSdkOrderBook,
        noRaw as PmxtSdkOrderBook,
        capturedAt
      ));
    }
    this.emit(`pmxt books=${books.length}`);
    return books;
  }

  private extractOutcomeIds(markets: PmxtMarketSnapshot[]): string[] {
    const ids: string[] = [];
    for (const market of markets) {
      const { yes, no } = outcomeIdsFor(market);
      ids.push(yes, no);
    }
    return ids;
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  private emit(message: string): void {
    this.options.onDiagnostic?.(message);
  }
}
