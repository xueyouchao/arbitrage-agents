import { describe, expect, it, vi } from "vitest";
import {
  PmxtHostedVenueClient,
  PmxtHostedVenueClientOptions,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-hosted-venue-client";

const capturedAt = "2026-07-15T12:00:00.000Z";

function makeOptions(overrides: Partial<PmxtHostedVenueClientOptions> = {}): PmxtHostedVenueClientOptions {
  return {
    listMarkets: vi.fn(),
    listOrderbooks: vi.fn(),
    now: () => capturedAt,
    ...overrides,
  };
}

function snapshot(venueMarketId: string, yesOutcomeId: string, noOutcomeId: string) {
  return {
    venue: "pmxt" as const,
    venueMarketId,
    title: "BTC above 100k?",
    rawResolutionText: "",
    capturedAt,
    rawPayload: { id: venueMarketId, yesOutcomeId, noOutcomeId },
  };
}

describe("PMXT hosted venue client", () => {
  it("lists markets through the injected hosted client", async () => {
    const rawMarkets = [
      { id: "m1", title: "BTC above 100k?", outcomes: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] },
    ];
    const options = makeOptions({
      listMarkets: vi.fn().mockResolvedValue(rawMarkets),
    });
    const client = new PmxtHostedVenueClient(options);
    const markets = await client.listMarkets();
    expect(options.listMarkets).toHaveBeenCalledTimes(1);
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({ venue: "pmxt", venueMarketId: "m1" });
  });

  it("lists orderbooks by explicit outcome IDs", async () => {
    const rawBooks = {
      o1: { asks: [{ price: 0.52, size: 10 }] },
      o2: { asks: [{ price: 0.48, size: 5 }] },
    };
    const options = makeOptions({
      listOrderbooks: vi.fn().mockResolvedValue(rawBooks),
    });
    const client = new PmxtHostedVenueClient(options);
    const books = await client.listOrderbooks([snapshot("m1", "o1", "o2")]);
    expect(options.listOrderbooks).toHaveBeenCalledWith(["o1", "o2"]);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ venue: "pmxt", marketId: "m1", yesAsk: 0.52, noAsk: 0.48 });
  });

  it("rejects orderbook fetch when market lacks explicit outcome IDs", async () => {
    const options = makeOptions();
    const client = new PmxtHostedVenueClient(options);
    await expect(
      client.listOrderbooks([{ ...snapshot("m1", "o1", "o2"), rawPayload: { id: "m1" } }])
    ).rejects.toThrow("PMXT market m1 lacks explicit YES/NO outcome ids");
  });

  it("does not expose account, wallet, balance, position, order, or execution methods", () => {
    const client = new PmxtHostedVenueClient(makeOptions());
    const forbidden = [
      "getAccount",
      "getWallet",
      "getBalance",
      "getPositions",
      "placeOrder",
      "cancelOrder",
      "execute",
    ];
    for (const method of forbidden) {
      expect(client).not.toHaveProperty(method);
    }
  });

  it("emits diagnostics but no actionable secrets", async () => {
    const diagnostics: string[] = [];
    const rawBooks = {
      o1: { asks: [{ price: 0.52, size: 10 }] },
      o2: { asks: [{ price: 0.48, size: 5 }] },
      o3: { asks: [{ price: 0.6, size: 1 }] },
      o4: { asks: [{ price: 0.4, size: 2 }] },
    };
    const options = makeOptions({
      listMarkets: vi.fn().mockResolvedValue([
        { id: "m1", title: "BTC above 100k?", outcomes: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] },
        { id: "m2", title: "ETH above 5k?", outcomes: [{ id: "o3", label: "Yes" }, { id: "o4", label: "No" }] },
      ]),
      listOrderbooks: vi.fn().mockResolvedValue(rawBooks),
      onDiagnostic: (message: string) => diagnostics.push(message),
    });
    const client = new PmxtHostedVenueClient(options);
    const markets = await client.listMarkets();
    const books = await client.listOrderbooks(markets);
    expect(books).toHaveLength(2);
    expect(diagnostics).toEqual(["pmxt markets=2", "pmxt books=2"]);
    for (const message of diagnostics) {
      expect(message).not.toMatch(/apiKey|key|token|secret|password/i);
    }
  });
});
