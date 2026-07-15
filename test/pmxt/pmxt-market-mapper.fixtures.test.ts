import { describe, expect, it } from "vitest";
import { mapPmxtMarketToSnapshot } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";
import {
  binaryYesNoMarket,
  capturedAt,
  marketAmbiguousOrientation,
  marketAmbiguousOutcomeId,
  marketMissingId,
  marketMixedCaseYesNo,
  marketNoOutcomes,
  marketNonBinary,
  marketWithNoDescription,
  marketWithUnknownFields,
  marketYesNoLowercase,
} from "./fixtures/markets";

describe("PMXT market mapper fixtures", () => {
  it("maps a binary YES/NO market", () => {
    const snapshot = mapPmxtMarketToSnapshot(binaryYesNoMarket, capturedAt);
    expect(snapshot.venueMarketId).toBe("pmxt-m1");
    expect(snapshot.title).toBe(binaryYesNoMarket.title);
    expect(snapshot.rawResolutionText).toBe(binaryYesNoMarket.description);
    expect(snapshot.rawPayload.yesOutcomeId).toBe("o1");
    expect(snapshot.rawPayload.noOutcomeId).toBe("o2");
  });

  it("falls back to id when title is missing", () => {
    const snapshot = mapPmxtMarketToSnapshot(marketWithNoDescription, capturedAt);
    expect(snapshot.title).toBe("pmxt-m2");
    expect(snapshot.rawResolutionText).toBe("");
  });

  it("preserves unknown fields in rawPayload", () => {
    const snapshot = mapPmxtMarketToSnapshot(marketWithUnknownFields, capturedAt);
    expect(snapshot.rawPayload).toMatchObject({
      id: "pmxt-m1",
      sourceExchange: "polymarket",
      extraField: "surprise",
    });
  });

  it("rejects a market with missing id", () => {
    expect(() => mapPmxtMarketToSnapshot(marketMissingId, capturedAt)).toThrow("PMXT market id is missing");
  });

  it("rejects a market with no outcomes", () => {
    expect(() => mapPmxtMarketToSnapshot(marketNoOutcomes, capturedAt)).toThrow("PMXT market has no explicit outcomes");
  });

  it("rejects a non-binary market", () => {
    expect(() => mapPmxtMarketToSnapshot(marketNonBinary, capturedAt)).toThrow("PMXT market is not binary");
  });

  it("rejects an ambiguous outcome id", () => {
    expect(() => mapPmxtMarketToSnapshot(marketAmbiguousOutcomeId, capturedAt)).toThrow(
      "PMXT outcome identity is ambiguous"
    );
  });

  it("rejects ambiguous YES/NO orientation", () => {
    expect(() => mapPmxtMarketToSnapshot(marketAmbiguousOrientation, capturedAt)).toThrow(
      "PMXT outcome orientation is ambiguous"
    );
  });

  it("accepts lowercase yes/no labels", () => {
    const snapshot = mapPmxtMarketToSnapshot(marketYesNoLowercase, capturedAt);
    expect(snapshot.rawPayload.yesOutcomeId).toBe("y");
    expect(snapshot.rawPayload.noOutcomeId).toBe("n");
  });

  it("accepts uppercase YES/NO labels", () => {
    const snapshot = mapPmxtMarketToSnapshot(marketMixedCaseYesNo, capturedAt);
    expect(snapshot.rawPayload.yesOutcomeId).toBe("y");
    expect(snapshot.rawPayload.noOutcomeId).toBe("n");
  });
});
