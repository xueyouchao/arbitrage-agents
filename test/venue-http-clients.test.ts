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
          no_dollars: [["0.35", "5"], ["0.37", "30"], ["0.10", "1"]]
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
        yesDepth: [{ price: 0.63, size: 30 }, { price: 0.65, size: 5 }, { price: 0.9, size: 1 }],
        noDepth: [{ price: 0.58, size: 20 }, { price: 0.6, size: 10 }],
        stale: false
      })
    ]);
  });

  it("maps Polymarket CLOB YES/NO token asks to market book", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.53", size: "10" }, { price: "0.51", size: "100" }, { price: "bad", size: "1" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.46", size: "5" }, { price: "0.44", size: "25" }] }), { status: 200 }));
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
        yesDepth: [{ price: 0.51, size: 100 }, { price: 0.53, size: 10 }],
        noDepth: [{ price: 0.44, size: 25 }, { price: 0.46, size: 5 }],
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

  it("maps Kalshi market fallback fields and stale malformed orderbook levels", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ markets: [{ id: "fallback-id", subtitle: "Fallback title", settlement_sources: "Fallback rules" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orderbook: {
          yes: [["101", "10"], ["0.20"], ["bad", "5"]],
          no: "malformed"
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 });
    const markets = await client.listMarkets();
    const books = await client.listOrderbooks(markets);

    expect(markets).toEqual([
      expect.objectContaining({ venueMarketId: "fallback-id", title: "Fallback title", rawResolutionText: "Fallback rules" })
    ]);
    expect(books).toEqual([
      expect.objectContaining({
        marketId: "fallback-id",
        yesAsk: 1,
        noAsk: 1,
        yesAvailableUsd: 0,
        noAvailableUsd: 0,
        yesDepth: [],
        noDepth: [],
        stale: true
      })
    ]);
  });

  it("does not mark Kalshi books stale when bid-only payload derives usable YES/NO asks", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        orderbook_fp: {
          yes_dollars: [["0.067", "100"]],
          no_dollars: [["0.933", "100"]]
        }
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const books = await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listOrderbooks([
      snapshot("kalshi", "KPROD-1", {})
    ]);

    expect(books).toEqual([
      expect.objectContaining({
        marketId: "KPROD-1",
        venue: "kalshi",
        yesAsk: 0.067,
        noAsk: 0.933,
        stale: false
      })
    ]);
  });

  it("maps Polymarket market fallback fields and token ID array/outcome ordering", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "poly-id", title: "Fallback question", description: "Fallback description", tokenIds: ["no-token", "yes-token"], outcomes: ["No", "Yes"] }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.14", size: "2" }, { price: "0.12", size: "10" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.81", size: "5" }, { price: "0.83", size: "3" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retryDelayMs: 0 });
    const markets = await client.listMarkets();
    const books = await client.listOrderbooks(markets);

    expect(markets).toEqual([
      expect.objectContaining({ venueMarketId: "poly-id", title: "Fallback question", rawResolutionText: "Fallback description" })
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://clob.test/book?token_id=yes-token", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://clob.test/book?token_id=no-token", expect.objectContaining({ method: "GET" }));
    expect(books).toEqual([expect.objectContaining({
      yesAsk: 0.12,
      noAsk: 0.81,
      yesAvailableUsd: 1.2,
      noAvailableUsd: 4.05,
      yesDepth: [{ price: 0.12, size: 10 }, { price: 0.14, size: 2 }],
      noDepth: [{ price: 0.81, size: 5 }, { price: 0.83, size: 3 }],
      stale: false
    })]);
  });

  it("does not mark Polymarket books stale for production ask payload shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.067", size: "200" }, { price: "0.07", size: "300" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "0.934", size: "150" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const books = await new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retryDelayMs: 0 }).listOrderbooks([
      snapshot("polymarket", "condition-prod", { clobTokenIds: JSON.stringify(["yes-token", "no-token"]), outcomes: JSON.stringify(["Yes", "No"]) })
    ]);

    expect(books).toEqual([
      expect.objectContaining({
        marketId: "condition-prod",
        venue: "polymarket",
        yesAsk: 0.067,
        noAsk: 0.934,
        stale: false
      })
    ]);
  });

  it("drops Polymarket books with missing or malformed token IDs and marks empty CLOB books stale", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ asks: [{ price: "2", size: "10" }, { price: "0.5", size: "0" }, { notPrice: "0.4" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bids: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const books = await new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retryDelayMs: 0 }).listOrderbooks([
      snapshot("polymarket", "missing", {}),
      snapshot("polymarket", "malformed", { clobTokenIds: "not-json", outcomes: "not-json" }),
      snapshot("polymarket", "empty", { clob_token_ids: JSON.stringify(["yes-token", "no-token"]) })
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(books).toEqual([
      expect.objectContaining({
        marketId: "empty",
        yesAsk: 0.02,
        noAsk: 1,
        yesAvailableUsd: 0.2,
        noAvailableUsd: 0,
        yesDepth: [{ price: 0.02, size: 10 }],
        noDepth: [],
        stale: true
      })
    ]);
  });

  it("retries thrown network errors and surfaces the last failure after retry exhaustion", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network"))
      .mockRejectedValueOnce(new Error("still down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retries: 1, retryDelayMs: 0 }).listMarkets()).rejects.toThrow("still down");

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
