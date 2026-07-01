import { afterEach, describe, expect, it, vi } from "vitest";
import { PolymarketTradingClient } from "../src/contexts/venues/infrastructure/polymarket-trading-client";
import type { PolymarketTradingClientOptions } from "../src/contexts/venues/infrastructure/polymarket-trading-client";
import type { OrderSigner } from "../src/contexts/venues/domain/trading";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function mockSigner(impl?: (payload: Record<string, unknown>) => Promise<string>): OrderSigner {
  return { signOrder: vi.fn(impl ?? (async () => "0xmocksignature")) };
}

describe("PolymarketTradingClient constructor", () => {
  it("throws when no signer is provided", () => {
    expect(() => new PolymarketTradingClient({
      privateKey: "0xabc123",
      walletAddress: "0xWallet"
    } as unknown as PolymarketTradingClientOptions)).toThrow(/signer/);
  });
});

describe("PolymarketTradingClient.placeOrder", () => {
  it("POSTs to the CLOB /order endpoint with the correct payload shape and an auth signature", async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true, orderId: "poly-order-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const signer = mockSigner();

    const client = new PolymarketTradingClient({
      privateKey: "0xabc123",
      walletAddress: "0xWallet",
      signer
    });

    const result = await client.placeOrder("token-xyz", "buy", 0.55, 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://clob.polymarket.com/order");
    expect(init?.method).toBe("POST");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.order).toEqual(expect.objectContaining({
      tokenID: "token-xyz",
      side: "buy",
      price: 0.55,
      size: 10
    }));
    expect(body.signature).toBe("0xmocksignature");
    expect(body.signer).toBe("0xWallet");

    expect(result).toEqual(expect.objectContaining({
      orderId: "poly-order-1",
      venue: "polymarket",
      status: "placed"
    }));
  });
});

describe("PolymarketTradingClient.cancelOrder", () => {
  it("POSTs to the CLOB /cancel-orders endpoint with the order id and an auth signature", async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const signer = mockSigner(async () => "0xcancelsig");

    const client = new PolymarketTradingClient({
      privateKey: "0xabc123",
      walletAddress: "0xWallet",
      signer
    });

    await client.cancelOrder("poly-order-99");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://clob.polymarket.com/cancel-orders");
    expect(init?.method).toBe("POST");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.orderID).toBe("poly-order-99");
    expect(body.signature).toBe("0xcancelsig");
    expect(body.signer).toBe("0xWallet");
  });

  it("throws when the cancel endpoint returns a non-OK status", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const signer = mockSigner(async () => "0x");
    const client = new PolymarketTradingClient({
      privateKey: "0xabc123",
      walletAddress: "0xWallet",
      signer
    });

    await expect(client.cancelOrder("poly-order-bad")).rejects.toThrow("Polymarket cancel failed: 400");
  });
});

describe("PolymarketTradingClient signing flow", () => {
  it("passes the order payload to the signer and forwards the resulting signature in the request", async () => {
    const fetchMock = vi.fn(async () => okResponse({ orderId: "poly-sig-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const signOrder = vi.fn(async (payload: Record<string, unknown>) =>
      `0xderived-from-${JSON.stringify(payload.tokenID)}-${payload.side}`
    );
    const signer: OrderSigner = { signOrder };

    const client = new PolymarketTradingClient({
      privateKey: "0xabc123",
      walletAddress: "0xWallet",
      signer
    });

    await client.placeOrder("token-sign", "sell", 0.4, 5);

    // The signer must have been invoked with the order payload.
    expect(signOrder).toHaveBeenCalledTimes(1);
    const signedPayload = signOrder.mock.calls[0][0] as Record<string, unknown>;
    expect(signedPayload).toEqual(expect.objectContaining({
      tokenID: "token-sign",
      side: "sell",
      price: 0.4,
      size: 5
    }));

    // The signature forwarded in the POST body must be derived from the signer.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.signature).toBe(`0xderived-from-"token-sign"-sell`);
  });
});