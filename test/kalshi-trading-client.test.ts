import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { KalshiTradingClient, OrderResult } from "../src/contexts/venues/infrastructure/kalshi-trading-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return privateKey;
}

describe("KalshiTradingClient", () => {
  it("placeOrder sends POST /orders with ticker, side, price, size and auth headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        order_id: "ord-123",
        status: "resting",
        filled_size: 0,
        avg_fill_price: 0
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiTradingClient({
      apiKeyId: "key-id-abc",
      privateKey: testPrivateKey()
    });

    const result = await client.placeOrder("KXBTC-100K", "yes", 0.55, 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://external-api.kalshi.com/trade-api/v2/orders");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ ticker: "KXBTC-100K", side: "yes", price: 0.55, size: 10 });
    const headers = init?.headers as Record<string, string>;
    expect(headers["KALSHI-ACCESS-KEY-ID"]).toBe("key-id-abc");
    expect(headers["KALSHI-ACCESS-SIGNATURE"]).toBeTruthy();
    expect(result).toEqual<OrderResult>({
      orderId: "ord-123",
      status: "resting",
      filledSize: 0,
      avgFillPrice: 0
    });
  });

  it("cancelOrder sends DELETE /orders/{orderId} with auth headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiTradingClient({
      apiKeyId: "key-id-abc",
      privateKey: testPrivateKey()
    });

    await client.cancelOrder("ord-456");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://external-api.kalshi.com/trade-api/v2/orders/ord-456");
    expect(init?.method).toBe("DELETE");
    const headers = init?.headers as Record<string, string>;
    expect(headers["KALSHI-ACCESS-KEY-ID"]).toBe("key-id-abc");
    expect(headers["KALSHI-ACCESS-SIGNATURE"]).toBeTruthy();
  });

  it("signature header is a valid RSA-SHA256 signature of the request path+method+body", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        order_id: "ord-789",
        status: "resting",
        filled_size: 0,
        avg_fill_price: 0
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiTradingClient({
      apiKeyId: "key-id-sig",
      privateKey
    });

    await client.placeOrder("KXBTC-200K", "no", 0.30, 5);

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    const signature = headers["KALSHI-ACCESS-SIGNATURE"];
    const method = init?.method as string;
    const body = init?.body as string;

    // Recompute the signed payload the same way the client does and verify
    // against the public key to prove it is a genuine RSA-SHA256 signature.
    const { createVerify } = await import("node:crypto");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(method + url + body);
    verifier.end();
    expect(
      verifier.verify(publicKey, Buffer.from(signature, "base64"))
    ).toBe(true);
  });

  it("OrderResult has the shape orderId, status, filledSize, avgFillPrice", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        order_id: "ord-shape",
        status: "matched",
        filled_size: 10,
        avg_fill_price: 0.55
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new KalshiTradingClient({
      apiKeyId: "key-id-abc",
      privateKey: testPrivateKey()
    });

    const result = await client.placeOrder("KXBTC-100K", "yes", 0.55, 10);

    expect(result).toEqual({
      orderId: "ord-shape",
      status: "matched",
      filledSize: 10,
      avgFillPrice: 0.55
    });
    // Type-level check: all four fields are present and correctly typed.
    const _typeCheck: OrderResult = result;
    expect(_typeCheck).toBe(result);
  });
});