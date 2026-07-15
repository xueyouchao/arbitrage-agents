import { describe, expect, it } from "vitest";
import {
  mapPmxtOrderbookToMarketBook,
  PmxtSdkOrderBook,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";

const capturedAt = "2026-07-15T12:00:00.000Z";

function yesBook(overrides: Partial<PmxtSdkOrderBook> = {}): PmxtSdkOrderBook {
  return { asks: [{ price: 0.52, size: 10 }], ...overrides };
}

function noBook(overrides: Partial<PmxtSdkOrderBook> = {}): PmxtSdkOrderBook {
  return { asks: [{ price: 0.48, size: 5 }], ...overrides };
}

describe("PMXT orderbook mapper", () => {
  it("maps a binary PMXT orderbook to a market book", () => {
    const marketBook = mapPmxtOrderbookToMarketBook("pmxt-m1", yesBook(), noBook(), capturedAt);
    expect(marketBook).toEqual({
      marketId: "pmxt-m1",
      venue: "pmxt",
      yesAsk: 0.52,
      noAsk: 0.48,
      yesAvailableUsd: 5.2,
      noAvailableUsd: 2.4,
      yesDepth: [{ price: 0.52, size: 10 }],
      noDepth: [{ price: 0.48, size: 5 }],
      capturedAt,
      stale: false,
      rawPayload: expect.any(Object),
    });
  });

  it("sorts asks by price ascending", () => {
    const marketBook = mapPmxtOrderbookToMarketBook(
      "pmxt-m1",
      yesBook({ asks: [{ price: 0.6, size: 1 }, { price: 0.5, size: 2 }] }),
      noBook(),
      capturedAt
    );
    expect(marketBook.yesDepth).toEqual([
      { price: 0.5, size: 2 },
      { price: 0.6, size: 1 },
    ]);
    expect(marketBook.yesAsk).toBe(0.5);
  });

  it("marks an empty book stale without synthesizing prices", () => {
    const marketBook = mapPmxtOrderbookToMarketBook(
      "pmxt-m1",
      yesBook({ asks: [] }),
      noBook({ asks: [] }),
      capturedAt
    );
    expect(marketBook.stale).toBe(true);
    expect(marketBook.yesAsk).toBeUndefined();
    expect(marketBook.noAsk).toBeUndefined();
  });

  it("rejects a book with missing market id", () => {
    expect(() => mapPmxtOrderbookToMarketBook("", yesBook(), noBook(), capturedAt)).toThrow(
      "PMXT orderbook market id is missing"
    );
  });

  it("rejects a price outside the [0,1] unit interval", () => {
    expect(() =>
      mapPmxtOrderbookToMarketBook("pmxt-m1", yesBook({ asks: [{ price: 1.2, size: 1 }] }), noBook(), capturedAt)
    ).toThrow("PMXT price is ambiguous");
  });

  it("rejects a non-positive size", () => {
    expect(() =>
      mapPmxtOrderbookToMarketBook("pmxt-m1", yesBook({ asks: [{ price: 0.5, size: 0 }] }), noBook(), capturedAt)
    ).toThrow("PMXT size unit is ambiguous");
  });

  it("preserves unknown fields in rawPayload", () => {
    const marketBook = mapPmxtOrderbookToMarketBook(
      "pmxt-m1",
      { asks: [{ price: 0.5, size: 1 }], surprise: "field" } as PmxtSdkOrderBook,
      noBook(),
      capturedAt
    );
    expect(marketBook.rawPayload).toHaveProperty("yesBook.surprise", "field");
  });
});
