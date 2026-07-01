import { createSign } from "node:crypto";
import { OrderResult } from "../domain/trading";

export interface KalshiTradingClientOptions {
  apiKeyId: string;
  privateKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

/**
 * Authenticated trading client for the Kalshi exchange API. Each request is
 * signed with RSA-SHA256 using the Kalshi auth scheme:
 * `method + path + timestamp + body` (path only, not the full URL).
 * The current ISO timestamp is sent via the `KALSHI-ACCESS-TIMESTAMP` header.
 */
export class KalshiTradingClient {
  private readonly baseUrl: string;
  private readonly apiKeyId: string;
  private readonly privateKey: string;

  constructor(options: KalshiTradingClientOptions) {
    if (!options.apiKeyId) {
      throw new Error("KalshiTradingClient requires a non-empty apiKeyId");
    }
    if (!options.privateKey) {
      throw new Error("KalshiTradingClient requires a non-empty privateKey");
    }
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKeyId = options.apiKeyId;
    this.privateKey = options.privateKey;
  }

  async placeOrder(
    ticker: string,
    side: "yes" | "no",
    price: number,
    size: number
  ): Promise<OrderResult> {
    const path = "/orders";
    const body = JSON.stringify({ ticker, side, price, size });
    const response = await this.sendSignedRequest(path, "POST", body);
    if (!response.ok) {
      throw new Error(`Kalshi placeOrder failed: ${response.status}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      orderId: String(payload.order_id),
      venue: "kalshi",
      status: String(payload.status),
      filledSize: Number(payload.filled_size ?? 0),
      avgFillPrice: Number(payload.avg_fill_price ?? 0)
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const path = `/orders/${encodeURIComponent(orderId)}`;
    const response = await this.sendSignedRequest(path, "DELETE", "");
    if (!response.ok && response.status !== 204) {
      throw new Error(`Kalshi cancelOrder failed: ${response.status}`);
    }
  }

  private async sendSignedRequest(
    path: string,
    method: string,
    body: string
  ): Promise<Response> {
    const timestamp = new Date().toISOString();
    const signature = this.sign(method + path + timestamp + body);
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY-ID": this.apiKeyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp
      },
      body: body || undefined
    });
  }

  private sign(payload: string): string {
    const signer = createSign("RSA-SHA256");
    signer.update(payload);
    signer.end();
    return signer.sign(this.privateKey, "base64");
  }
}