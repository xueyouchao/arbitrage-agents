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

  it("prefers original Kalshi title and resolution text with robust fallbacks for multi-leg markets", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        markets: [
          {
            ticker: "KXBTC-100K",
            title: "Will Bitcoin be above $100,000?",
            rules_primary: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z"
          },
          {
            market_ticker: "KXMEX-TIE",
            event_ticker: "KXMEX-EVENT",
            title: "yes Tie,yes Mexico,",
            rules_primary: "",
            settlement_sources: "",
            description: "Resolves to the team winning the match."
          },
          {
            id: "KXEMPTY",
            event_ticker: "KXEMPTY-EVENT",
            market_ticker: "KXEMPTY-MARKET",
            title: "",
            subtitle: "",
            rules_primary: "",
            settlement_sources: "",
            yes_sub_title: "Yes outcome details",
            no_sub_title: "No outcome details"
          }
        ]
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const markets = await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listMarkets();

    expect(markets).toEqual([
      expect.objectContaining({
        venueMarketId: "KXBTC-100K",
        title: "Will Bitcoin be above $100,000?",
        rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z"
      }),
      expect.objectContaining({
        venueMarketId: "KXMEX-TIE",
        title: "yes Tie,yes Mexico,",
        rawResolutionText: "Resolves to the team winning the match."
      }),
      expect.objectContaining({
        venueMarketId: "KXEMPTY",
        title: "KXEMPTY-EVENT / KXEMPTY-MARKET",
        rawResolutionText: "YES: Yes outcome details / NO: No outcome details"
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

  it("falls back through title/ticker when Kalshi subtitle pair is empty", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        markets: [
          {
            id: "KXEMPTY-SUB",
            event_ticker: "KXEMPTY-SUB-EVENT",
            market_ticker: "KXEMPTY-SUB-MARKET",
            title: "Title fallback",
            subtitle: "",
            rules_primary: "",
            settlement_sources: "",
            description: "",
            yes_sub_title: "",
            no_sub_title: ""
          }
        ]
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const markets = await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listMarkets();

    expect(markets).toEqual([
      expect.objectContaining({
        venueMarketId: "KXEMPTY-SUB",
        title: "Title fallback",
        rawResolutionText: "Title fallback"
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

  it("uses consistent capturedAt timestamp for all Kalshi markets in a batch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        markets: [
          { ticker: "KXWC-A", title: "Market A", rules_primary: "Rules A" },
          { ticker: "KXWC-B", title: "Market B", rules_primary: "Rules B" }
        ]
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const markets = await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listMarkets();

    expect(markets).toHaveLength(2);
    // All snapshots from one batch should share the same capturedAt.
    expect(markets[0].capturedAt).toBe(markets[1].capturedAt);
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

  it("includes event_ticker in the query URL when eventTicker option is provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ markets: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new KalshiPublicVenueClient("https://kalshi.test", { eventTicker: "KXWC", retryDelayMs: 0 }).listMarkets();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://kalshi.test/markets?event_ticker=KXWC&status=open&limit=500",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("does not include event_ticker in the query URL when no eventTicker is provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ markets: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new KalshiPublicVenueClient("https://kalshi.test", { retryDelayMs: 0 }).listMarkets();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://kalshi.test/markets?status=open&limit=100",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("uses limit=500 when eventTicker is provided", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ markets: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new KalshiPublicVenueClient("https://kalshi.test", { eventTicker: "KXWC", retryDelayMs: 0 }).listMarkets();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("limit=500"),
      expect.objectContaining({ method: "GET" })
    );
  });

  it("queries /events?slug=fifwc and fetches markets under that event when eventSlug is provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: "evt-fifwc",
          slug: "fifwc",
          markets: [{ id: "mkt-1" }, { id: "mkt-2" }]
        }
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: "mkt-1", conditionId: "cond-1", question: "Netherlands vs Japan", description: "Match desc 1" },
        { id: "mkt-2", conditionId: "cond-2", question: "Brazil vs Argentina", description: "Match desc 2" }
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { eventSlug: "fifwc", retryDelayMs: 0 });
    const markets = await client.listMarkets();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://gamma.test/events?slug=fifwc", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://gamma.test/markets?closed=false&limit=500&id=mkt-1&id=mkt-2", expect.objectContaining({ method: "GET" }));
    expect(markets).toHaveLength(2);
    expect(markets).toEqual([
      expect.objectContaining({ venueMarketId: "cond-1", title: "Netherlands vs Japan", rawResolutionText: "Match desc 1" }),
      expect.objectContaining({ venueMarketId: "cond-2", title: "Brazil vs Argentina", rawResolutionText: "Match desc 2" })
    ]);
  });

  it("injects 'FIFA World Cup 2026\\n' into rawResolutionText when a market tag contains 'world cup' and '2026'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: "evt-fifwc",
          slug: "fifwc",
          markets: [{ id: "mkt-1" }]
        }
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: "mkt-1",
          conditionId: "cond-1",
          question: "Netherlands vs Japan",
          description: "Match desc",
          tags: [{ label: "FIFA World Cup 2026" }]
        }
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { eventSlug: "fifwc", retryDelayMs: 0 });
    const markets = await client.listMarkets();

    expect(markets).toEqual([
      expect.objectContaining({ rawResolutionText: "FIFA World Cup 2026\nMatch desc" })
    ]);
  });

  it("does not inject WC tag when tag contains 'world cup' but not '2026'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: "evt-fifwc",
          slug: "fifwc",
          markets: [{ id: "mkt-1" }]
        }
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: "mkt-1",
          conditionId: "cond-1",
          question: "Netherlands vs Japan",
          description: "Match desc",
          tags: [{ label: "FIFA World Cup 2022" }]
        }
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { eventSlug: "fifwc", retryDelayMs: 0 });
    const markets = await client.listMarkets();

    expect(markets).toEqual([
      expect.objectContaining({ rawResolutionText: "Match desc" })
    ]);
  });

  it("still queries /markets?closed=false&limit=100 when no eventSlug is provided (backward compat)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new PolymarketPublicVenueClient("https://gamma.test", "https://clob.test", { retryDelayMs: 0 }).listMarkets();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gamma.test/markets?closed=false&limit=100",
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
