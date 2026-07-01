import { OrderResult, OrderSide, OrderSigner } from "../domain/trading";

export interface PolymarketTradingClientOptions {
  /**
   * Ethereum EOA private key used to sign CLOB orders. Production callers
   * pass `config.polyPrivateKey`.
   */
  privateKey?: string;
  /**
   * Wallet address corresponding to `privateKey`. Sent as the `signer`
   * field in the CLOB order payload.
   */
  walletAddress?: string;
  /**
   * Abstracts the EOA wallet signing step. ethers.js is not yet a
   * dependency of this repo, so the signing implementation is injected
   * rather than hard-wired. The production wiring will pass an
   * ethers.js-based signer; tests pass a mock.
   *
   * REQUIRED — there is no default. A caller that omits the signer
   * cannot sign orders and would silently send zero-signature orders to
   * the live CLOB, so the constructor throws if it is missing.
   */
  signer: OrderSigner;
  /** CLOB API base URL. Defaults to the production endpoint. */
  clobBaseUrl?: string;
}

const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";

/**
 * Authenticated trading client for the Polymarket CLOB API
 * (https://clob.polymarket.com). Orders are EOA-signed via the injected
 * `OrderSigner` (ethers.js Wallet in production) and submitted to the
 * CLOB `POST /order` endpoint.
 *
 * NOTE: ethers.js is not currently a dependency of this repo. Until it is
 * installed, callers must inject an `OrderSigner`. The constructor throws
 * when no signer is provided so unsigned orders can never be sent.
 */
export class PolymarketTradingClient {
  private readonly clobBaseUrl: string;
  private readonly privateKey: string;
  private readonly walletAddress: string;
  private readonly signer: OrderSigner;

  constructor(options: PolymarketTradingClientOptions) {
    if (!options.signer) {
      throw new Error(
        "PolymarketTradingClient requires a signer; provide an OrderSigner (ethers.js Wallet in production)."
      );
    }
    this.clobBaseUrl = options.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL;
    this.privateKey = options.privateKey ?? "";
    this.walletAddress = options.walletAddress ?? "";
    this.signer = options.signer;
  }

  async placeOrder(
    tokenId: string,
    side: OrderSide,
    price: number,
    size: number
  ): Promise<OrderResult> {
    const order = {
      tokenID: tokenId,
      side,
      price,
      size
    };

    const signature = await this.signer.signOrder(order);

    const payload = {
      order,
      signature,
      signer: this.walletAddress
    };

    const response = await fetch(`${this.clobBaseUrl}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        orderId: "",
        venue: "polymarket",
        status: "failed",
        rawResponse: text
      };
    }

    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      orderId: String(body.orderId ?? body.order_id ?? ""),
      venue: "polymarket",
      status: "placed",
      rawResponse: body
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const signature = await this.signer.signOrder({ action: "cancel", orderID: orderId });
    const payload = {
      orderID: orderId,
      signature,
      signer: this.walletAddress
    };

    const response = await fetch(`${this.clobBaseUrl}/cancel-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Polymarket cancel failed: ${response.status} ${text}`);
    }
  }
}