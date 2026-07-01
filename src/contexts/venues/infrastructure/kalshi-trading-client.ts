import { createSign } from "node:crypto";

export interface OrderResult {
  orderId: string;
  status: string;
  filledSize: number;
  avgFillPrice: number;
}

export interface KalshiTradingClientOptions {
  apiKeyId: string;
  privateKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

export class KalshiTradingClient {
  private readonly baseUrl: string;
  private readonly apiKeyId: string;
  private readonly privateKey: string;

  constructor(options: KalshiTradingClientOptions) {
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
    const url = `${this.baseUrl}/orders`;
    const body = JSON.stringify({ ticker, side, price, size });
    const response = await this.sendSignedRequest(url, "POST", body);
    if (!response.ok) {
      throw new Error(`Kalshi placeOrder failed: ${response.status}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      orderId: String(payload.order_id),
      status: String(payload.status),
      filledSize: Number(payload.filled_size ?? 0),
      avgFillPrice: Number(payload.avg_fill_price ?? 0)
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const url = `${this.baseUrl}/orders/${encodeURIComponent(orderId)}`;
    const response = await this.sendSignedRequest(url, "DELETE", "");
    if (!response.ok && response.status !== 204) {
      throw new Error(`Kalshi cancelOrder failed: ${response.status}`);
    }
  }

  private async sendSignedRequest(
    url: string,
    method: string,
    body: string
  ): Promise<Response> {
    const signature = this.sign(method + url + body);
    return fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY-ID": this.apiKeyId,
        "KALSHI-ACCESS-SIGNATURE": signature
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