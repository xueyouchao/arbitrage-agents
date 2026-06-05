import { afterEach, describe, expect, it, vi } from "vitest";
import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public venue HTTP clients", () => {
  it("maps Kalshi public bid orderbook to implied top-of-book asks", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        orderbook_fp: {
          yes_dollars: [["0.40", "10"], ["0.42", "20"]],
          no_dollars: [["0.35", "5"], ["0.37", "30"]]
        }
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const books = await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listOrderbooks([
      snapshot("kalshi", "KXBTCD-TEST", {})
    ]);

    expect(fetchMock).toHaveBeenCalledWith("https://kalshi.test/markets/KXBTCD-TEST/orderbook", expect.objectContaining({ method: "GET" }));
    expect(books).toEqual([
      expect.objectContaining({
        marketId: "KXBTCD-TEST",
        venue: "kalshi",
        yesAsk: 0.63,
        noAsk: 0.58,
        yesAvailableUsd: 18.9,
        noAvailableUsd: 11.6,
        stale: false
      })
    ]);
  });

  it("maps Polymarket CLOB YES/NO token asks to market book", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.51", size: "100" }, { price: "0.53", size: "10" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.44", size: "25" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const books = await new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retryDelayMs: 0 }).listOrderbooks([
      snapshot("polymarket", "condition-1", { clobTokenIds: JSON.stringify(["yes-token", "no-token"]), outcomes: JSON.stringify(["Yes", "No"]) })
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://clob.test/book?token_id=yes-token", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://clob.test/book?token_id=no-token", expect.objectContaining({ method: "GET" }));
    expect(books).toEqual([
      expect.objectContaining({
        marketId: "condition-1",
        venue: "polymarket",
        yesAsk: 0.51,
        noAsk: 0.44,
        yesAvailableUsd: 51,
        noAvailableUsd: 11,
        stale: false
      })
    ]);
  });

  it("retries retryable public HTTP failures without auth headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markets: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const markets = await new KalshiPublicVenueClient("https://kalshi.test", { retries: 1, retryDelayMs: 0 }).listMarkets();

    expect(markets).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.not.objectContaining({ headers: expect.anything() }));
    }
  });

  it("does not retry non-retryable public HTTP failures", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KalshiPublicVenueClient("https://kalshi.test", { retries: 2, retryDelayMs: 0 }).listMarkets()).rejects.toThrow("Kalshi markets failed: 400");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function snapshot(venue: "kalshi" | "polymarket", venueMarketId: string, rawPayload: Record<string, unknown>): VenueMarketSnapshot {
  return {
    venue,
    venueMarketId,
    title: "BTC above 100k",
    rawResolutionText: "Resolves using Coinbase BTC/USD",
    rawPayload,
    capturedAt: "2026-06-03T12:00:00.000Z"
  };
}
