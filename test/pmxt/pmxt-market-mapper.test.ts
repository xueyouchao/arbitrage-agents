import { describe, expect, it } from "vitest";
import {
  mapPmxtMarketToSnapshot,
  PmxtMarket,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";

const capturedAt = "2026-07-15T12:00:00.000Z";

function market(overrides: Partial<PmxtMarket> = {}): PmxtMarket {
  return {
    id: "pmxt-m1",
    outcomes: [
      { id: "o-yes", label: "Yes" },
      { id: "o-no", label: "No" },
    ],
    ...overrides,
  };
}

describe("PMXT market mapper", () => {
  it("maps a binary PMXT market to a snapshot with explicit outcome IDs", () => {
    const snapshot = mapPmxtMarketToSnapshot(market(), capturedAt);
    expect(snapshot).toEqual({
      venue: "pmxt",
      venueMarketId: "pmxt-m1",
      title: "pmxt-m1",
      rawResolutionText: "",
      capturedAt,
      rawPayload: expect.objectContaining({
        id: "pmxt-m1",
        yesOutcomeId: "o-yes",
        noOutcomeId: "o-no",
      }),
    });
  });

  it("uses an explicit title when present", () => {
    const snapshot = mapPmxtMarketToSnapshot(market({ title: "BTC above $100k?" }), capturedAt);
    expect(snapshot.title).toBe("BTC above $100k?");
  });

  it("uses an explicit description as resolution text when present", () => {
    const snapshot = mapPmxtMarketToSnapshot(
      market({ description: "Resolves per Coinbase BTC/USD at 2026-01-01." }),
      capturedAt
    );
    expect(snapshot.rawResolutionText).toBe("Resolves per Coinbase BTC/USD at 2026-01-01.");
  });

  it("rejects a market with a missing id", () => {
    expect(() => mapPmxtMarketToSnapshot(market({ id: "" }), capturedAt)).toThrow(
      "PMXT market id is missing"
    );
  });

  it("rejects a market with no outcomes", () => {
    expect(() => mapPmxtMarketToSnapshot(market({ outcomes: [] }), capturedAt)).toThrow(
      "PMXT market has no explicit outcomes"
    );
  });

  it("rejects a market with an outcome missing an id", () => {
    expect(() =>
      mapPmxtMarketToSnapshot(market({ outcomes: [{ id: "o-yes" }, { id: "", label: "No" }] }), capturedAt)
    ).toThrow("PMXT outcome identity is ambiguous");
  });

  it("rejects a non-binary market", () => {
    expect(() =>
      mapPmxtMarketToSnapshot(
        market({ outcomes: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
        capturedAt
      )
    ).toThrow("PMXT market is not binary");
  });

  it("rejects a binary market whose labels do not resolve to YES/NO", () => {
    expect(() =>
      mapPmxtMarketToSnapshot(
        market({ outcomes: [{ id: "a", label: "Up" }, { id: "b", label: "Down" }] }),
        capturedAt
      )
    ).toThrow("PMXT outcome orientation is ambiguous");
  });

  it("preserves unknown fields in rawPayload without synthesizing semantics", () => {
    const snapshot = mapPmxtMarketToSnapshot(
      { ...market(), extraField: "surprise" } as PmxtMarket,
      capturedAt
    );
    expect(snapshot.rawPayload).toHaveProperty("extraField", "surprise");
  });
});
