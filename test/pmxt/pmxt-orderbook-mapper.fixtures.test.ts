import { describe, expect, it } from "vitest";
import { mapPmxtOrderbookToMarketBook } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import {
  badPriceBook,
  emptyNoBook,
  emptyYesBook,
  fullNoBook,
  fullYesBook,
  malformedLevelBook,
  oneSidedNoBook,
  oneSidedYesBook,
  sortedYesBook,
  unknownFieldYesBook,
  zeroSizeBook,
} from "./fixtures/orderbooks";
import { capturedAt } from "./fixtures/markets";

describe("PMXT orderbook mapper fixtures", () => {
  it("maps a full YES/NO book", () => {
    const book = mapPmxtOrderbookToMarketBook("pmxt-m1", fullYesBook, fullNoBook, capturedAt);
    expect(book.yesAsk).toBe(0.52);
    expect(book.noAsk).toBe(0.48);
    expect(book.yesAvailableUsd).toBe(5.2);
    expect(book.noAvailableUsd).toBe(2.4);
    expect(book.stale).toBe(false);
  });

  it("sorts asks by ascending price", () => {
    const book = mapPmxtOrderbookToMarketBook("pmxt-m1", sortedYesBook, fullNoBook, capturedAt);
    expect(book.yesDepth).toEqual([
      { price: 0.5, size: 2 },
      { price: 0.6, size: 1 },
    ]);
    expect(book.yesAsk).toBe(0.5);
  });

  it("marks empty books stale without synthesizing prices", () => {
    const book = mapPmxtOrderbookToMarketBook("pmxt-m1", emptyYesBook, emptyNoBook, capturedAt);
    expect(book.stale).toBe(true);
    expect(book.yesAsk).toBeUndefined();
    expect(book.noAsk).toBeUndefined();
  });

  it("marks a one-sided book stale", () => {
    const book = mapPmxtOrderbookToMarketBook("pmxt-m1", oneSidedYesBook, oneSidedNoBook, capturedAt);
    expect(book.stale).toBe(true);
    expect(book.yesAsk).toBe(0.52);
    expect(book.noAsk).toBeUndefined();
  });

  it("preserves unknown fields in rawPayload", () => {
    const book = mapPmxtOrderbookToMarketBook("pmxt-m1", unknownFieldYesBook, fullNoBook, capturedAt);
    expect(book.rawPayload).toHaveProperty("yesBook.surprise", "field");
  });

  it("rejects a price outside [0,1]", () => {
    expect(() => mapPmxtOrderbookToMarketBook("pmxt-m1", badPriceBook, fullNoBook, capturedAt)).toThrow(
      "PMXT price is ambiguous"
    );
  });

  it("rejects a non-positive size", () => {
    expect(() => mapPmxtOrderbookToMarketBook("pmxt-m1", zeroSizeBook, fullNoBook, capturedAt)).toThrow(
      "PMXT size unit is ambiguous"
    );
  });

  it("rejects a malformed price level", () => {
    expect(() => mapPmxtOrderbookToMarketBook("pmxt-m1", malformedLevelBook, fullNoBook, capturedAt)).toThrow(
      "PMXT price is ambiguous"
    );
  });
});
