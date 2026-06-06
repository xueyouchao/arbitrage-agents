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
      clock: sequenceClock([
        "2026-06-03T11:59:59.000Z",
        capturedAt,
        "2026-06-03T12:00:01.000Z"
      ])
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.startedAt).toBe("2026-06-03T11:59:59.000Z");
    expect(result.completedAt).toBe("2026-06-03T12:00:01.000Z");
    expect(result.metrics).toMatchObject({
      marketsScanned: 2,
      normalizedMarkets: 2,
      candidatePairs: 1,
      opportunitiesFound: 1
    });
    expect(repository.snapshots).toHaveLength(2);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.candidatePairs[0].decision).toMatchObject({
      equivalenceClass: "A",
      decision: "tradable"
    });
    expect(repository.orderbookSnapshots).toHaveLength(2);
    expect(repository.orderbookSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          scanRunId: result.id,
          normalizedMarketId: "kalshi:K1",
          venue: "kalshi",
          venueMarketId: "K1",
          yesAsk: 0.42,
          noAsk: 0.62,
          yesAvailableUsd: 20,
          noAvailableUsd: 30,
          capturedAt,
          stale: false,
          rawPayload: expect.objectContaining({ marketId: "K1", venue: "kalshi" })
        }),
        expect.objectContaining({
          id: expect.any(String),
          scanRunId: result.id,
          normalizedMarketId: "polymarket:P1",
          venue: "polymarket",
          venueMarketId: "P1",
          yesAsk: 0.5,
          noAsk: 0.51,
          yesAvailableUsd: 50,
          noAvailableUsd: 12,
          capturedAt,
          stale: false,
          rawPayload: expect.objectContaining({ marketId: "P1", venue: "polymarket" })
        })
      ])
    );
    expect(repository.opportunities).toHaveLength(1);
    expect(repository.opportunities[0]).toMatchObject({
      opportunity: expect.objectContaining({ id: "kalshi:K1:polymarket:P1:kalshi_yes-polymarket_no" }),
      kalshiOrderbookSnapshotId: repository.orderbookSnapshots.find((snapshot) => snapshot.venue === "kalshi")?.id,
      polymarketOrderbookSnapshotId: repository.orderbookSnapshots.find((snapshot) => snapshot.venue === "polymarket")?.id
    });
  });

  it("uses the injected scan time for opportunity freshness", async () => {
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
    expect(result.startedAt).toBe(capturedAt);
    expect(result.completedAt).toBe(capturedAt);
    expect(repository.opportunities[0].opportunity.detectedAt).toBe(capturedAt);
    expect(result.metrics.opportunitiesFound).toBe(1);
  });

  it("persists stale orderbook snapshots without emitting opportunities", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 1, noAsk: 0.62, yesAvailableUsd: 0, noAvailableUsd: 30, capturedAt, stale: true }]
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
    expect(result.metrics.opportunitiesFound).toBe(0);
    expect(repository.orderbookSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scanRunId: result.id,
          venue: "kalshi",
          venueMarketId: "K1",
          yesAsk: undefined,
          noAsk: 0.62,
          stale: true
        })
      ])
    );
    expect(repository.opportunities).toHaveLength(0);
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

function sequenceClock(values: string[]): () => string {
  return () => values.shift() ?? values[values.length - 1] ?? new Date(0).toISOString();
}

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
