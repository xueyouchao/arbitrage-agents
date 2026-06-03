import { describe, expect, it, vi } from "vitest";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { StaticVenueClient } from "../src/contexts/venues/application/static-venue-client";
import { VenueClient, VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";

const capturedAt = "2026-06-03T12:00:00.000Z";

function market(venue: "kalshi" | "polymarket", id: string, title: string): VenueMarketSnapshot {
  return {
    venue,
    venueMarketId: id,
    title,
    rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z",
    rawPayload: { id, title },
    capturedAt
  };
}

describe("ReadOnlyScanner", () => {
  it("persists scan runs, snapshots, normalized markets, pairs, and opportunities without trading", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics).toMatchObject({
      marketsScanned: 2,
      normalizedMarkets: 2,
      candidatePairs: 1,
      opportunitiesFound: 1
    });
    expect(repository.snapshots).toHaveLength(2);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.opportunities).toHaveLength(1);
  });

  it("fetches orderbooks only after freshly fetched markets", async () => {
    const kalshiMarkets = [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")];
    const polymarketMarkets = [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")];
    const calls: string[] = [];
    const kalshiClient = sequencingClient("kalshi", kalshiMarkets, [
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }
    ], calls);
    const polymarketClient = sequencingClient("polymarket", polymarketMarkets, [
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }
    ], calls);

    const result = await new ReadOnlyScanner({
      kalshiClient,
      polymarketClient,
      repository: new InMemoryScannerRepository(),
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(calls.slice(0, 2)).toEqual(["kalshi:markets", "polymarket:markets"]);
    expect(calls).toContain("kalshi:books:K1");
    expect(calls).toContain("polymarket:books:P1");
    expect(kalshiClient.listOrderbooks).toHaveBeenCalledWith(kalshiMarkets);
    expect(polymarketClient.listOrderbooks).toHaveBeenCalledWith(polymarketMarkets);
  });

});

function sequencingClient(
  venue: "kalshi" | "polymarket",
  markets: VenueMarketSnapshot[],
  books: MarketBook[],
  calls: string[]
): VenueClient & { listOrderbooks: ReturnType<typeof vi.fn> } {
  return {
    listMarkets: vi.fn(async () => {
      calls.push(`${venue}:markets`);
      return markets;
    }),
    listOrderbooks: vi.fn(async (freshMarkets: VenueMarketSnapshot[]) => {
      calls.push(`${venue}:books:${freshMarkets.map((freshMarket) => freshMarket.venueMarketId).join(",")}`);
      return books;
    })
  };
}
