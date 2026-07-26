import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLYMARKET_CRYPTO_FEE_COEFFICIENT,
  resolvePolymarketFeeCoefficient,
  resolvePolymarketFeeRate
} from "../src/contexts/venues/domain/polymarket-fee-resolver";
import { ContractSide, MarketBook } from "../src/contexts/arbitrage/domain/opportunity";

function makeBook(overrides: Partial<MarketBook> = {}): MarketBook {
  return {
    marketId: "P1",
    venue: "polymarket",
    yesAsk: 0.5,
    noAsk: 0.51,
    yesAvailableUsd: 100,
    noAvailableUsd: 100,
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as MarketBook;
}

describe("resolvePolymarketFeeCoefficient", () => {
  it("returns the payload coefficient from a valid crypto fee schedule", () => {
    const book = makeBook({
      rawPayload: { market: { feeSchedule: { rate: 0.09, exponent: 1, takerOnly: true } } }
    });
    expect(resolvePolymarketFeeCoefficient(book)).toBe(0.09);
  });

  it("returns undefined for non-Polymarket venues", () => {
    const book = makeBook({ venue: "kalshi" as const });
    expect(resolvePolymarketFeeCoefficient(book)).toBeUndefined();
  });

  it("rejects NaN and non-finite rates", () => {
    for (const badRate of [NaN, Infinity, -Infinity]) {
      const book = makeBook({ rawPayload: { market: { feeSchedule: { rate: badRate } } } });
      expect(resolvePolymarketFeeCoefficient(book)).toBeUndefined();
    }
  });

  it("rejects out-of-range rates", () => {
    for (const badRate of [-0.01, 0, 1, 1.01]) {
      const book = makeBook({ rawPayload: { market: { feeSchedule: { rate: badRate } } } });
      expect(resolvePolymarketFeeCoefficient(book)).toBeUndefined();
    }
  });

  it("falls back to the top-level payload for backwards compatibility", () => {
    const book = makeBook({ rawPayload: { feeSchedule: { rate: 0.06 } } });
    expect(resolvePolymarketFeeCoefficient(book)).toBe(0.06);
  });
});

describe("DEFAULT_POLYMARKET_CRYPTO_FEE_COEFFICIENT", () => {
  it("matches the conservative 0.07 default used by the calculator", () => {
    expect(DEFAULT_POLYMARKET_CRYPTO_FEE_COEFFICIENT).toBe(0.07);
  });
});

describe("resolvePolymarketFeeRate", () => {
  it("returns coefficient * (1 - sidePrice) for a valid side", () => {
    const book = makeBook({
      rawPayload: { market: { feeSchedule: { rate: 0.09 } } }
    });
    expect(resolvePolymarketFeeRate(book, "NO" as ContractSide)).toBeCloseTo(0.09 * (1 - 0.51), 10);
    expect(resolvePolymarketFeeRate(book, "YES" as ContractSide)).toBeCloseTo(0.09 * (1 - 0.5), 10);
  });

  it("returns undefined when no valid coefficient is present", () => {
    const book = makeBook({ rawPayload: { market: {} } });
    expect(resolvePolymarketFeeRate(book, "NO" as ContractSide)).toBeUndefined();
  });
});
