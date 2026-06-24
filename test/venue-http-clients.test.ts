import { afterEach, describe, expect, it, vi } from "vitest";
import { KalshiPublicVenueClient, mapWithConcurrency, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
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

    await expect(new KalshiPublicVenueClient("https://kalshi.test", { retries: 2, retryDelayMs: 0 }).listMarkets()).rejects.toThrow("Kalshi markets failed: 400 after 1 attempt");

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

    await expect(new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retries: 1, retryDelayMs: 0 }).listMarkets()).rejects.toThrow("Polymarket markets failed: still down after 2 attempts (total backoff 0ms)");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits concurrency when listing Kalshi orderbooks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = { current: 0 };
    const maxActive = { current: 0 };

    const fetchMock = vi.fn(async () => {
      active.current += 1;
      maxActive.current = Math.max(maxActive.current, active.current);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.current -= 1;
      return new Response(JSON.stringify({
        orderbook_fp: { yes_dollars: [["0.40", "10"]], no_dollars: [["0.35", "5"]] }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const markets = Array.from({ length: 10 }, (_, i) => snapshot("kalshi", `M-${i}`, {}));
    const client = new KalshiPublicVenueClient("https://kalshi.test", { concurrency: 3, retryDelayMs: 0 });
    const booksPromise = client.listOrderbooks(markets);
    await vi.advanceTimersByTimeAsync(1000);
    const books = await booksPromise;

    expect(books).toHaveLength(10);
    expect(maxActive.current).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("limits concurrency when listing Polymarket orderbooks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const active = { current: 0 };
    const maxActive = { current: 0 };

    const fetchMock = vi.fn(async () => {
      active.current += 1;
      maxActive.current = Math.max(maxActive.current, active.current);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.current -= 1;
      return new Response(JSON.stringify({ asks: [{ price: "0.50", size: "10" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const markets = Array.from({ length: 8 }, (_, i) =>
      snapshot("polymarket", `condition-${i}`, { clobTokenIds: JSON.stringify(["yes-token", "no-token"]), outcomes: JSON.stringify(["Yes", "No"]) })
    );
    const client = new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { concurrency: 4, retryDelayMs: 0 });
    const booksPromise = client.listOrderbooks(markets);
    await vi.advanceTimersByTimeAsync(1000);
    const books = await booksPromise;

    expect(books).toHaveLength(8);
    // The concurrency cap now applies to individual /book fetches, not to
    // markets. With 16 total token-side fetches and concurrency=4, at most
    // four should be in flight at once.
    expect(maxActive.current).toBeLessThanOrEqual(4);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it("counts retries and applies deterministic backoff", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markets: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiPublicVenueClient("https://kalshi.test", {
      retries: 3,
      retryDelayMs: 100,
      jitter: () => 0.5
    });
    const promise = client.listMarkets();
    await vi.advanceTimersByTimeAsync(2000);
    const markets = await promise;

    expect(markets).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toEqual("https://kalshi.test/markets?status=open&limit=100");
  });

  it("includes attempt count and total backoff in final retry exhaustion error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiPublicVenueClient("https://kalshi.test", {
      retries: 2,
      retryDelayMs: 100,
      jitter: () => 0.5
    });
    const promise = expect(client.listMarkets()).rejects.toThrow("after 3 attempts (total backoff 300ms)");
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not add extra retries when a non-retryable status arrives on the final attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KalshiPublicVenueClient("https://kalshi.test", { retries: 2, retryDelayMs: 0 }).listMarkets()).rejects.toThrow("Kalshi markets failed: 400 after 3 attempts");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("mapWithConcurrency", () => {
  it("rejects early on first mapper failure and stops scheduling new work", async () => {
    const mapper = vi.fn(async (item: number, index: number) => {
      if (item === 3) throw new Error(`mapper blew up at index ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item * 2;
    });

    await expect(mapWithConcurrency([1, 2, 3, 4, 5], mapper, 2)).rejects.toThrow("mapper blew up at index 2");

    expect(mapper).toHaveBeenCalledTimes(3);
  });

  it("preserves output order with concurrency > 1", async () => {
    const mapper = async (item: number, index: number) => {
      // Deliberately slow down earlier indices so later ones finish first if order were not preserved.
      await new Promise((resolve) => setTimeout(resolve, (5 - index) * 2));
      return item * 10 + index;
    };
    const result = await mapWithConcurrency([0, 1, 2, 3, 4], mapper, 5);
    expect(result).toEqual([0, 11, 22, 33, 44]);
  });

  it("throws for concurrency <= 0", async () => {
    await expect(mapWithConcurrency([1], async (x) => x, 0)).rejects.toThrow("concurrency must be positive");
    await expect(mapWithConcurrency([1], async (x) => x, -1)).rejects.toThrow("concurrency must be positive");
  });

  it("runs sequentially when concurrency = 1", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency([1, 2, 3], async (x) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return x * 2;
    }, 1);
    expect(result).toEqual([2, 4, 6]);
    expect(maxActive).toBe(1);
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
