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

  it("preserves the PMXT catalog id and an explicitly stamped Kalshi ticker", () => {
    const unified = {
      marketId: "01982c2b-a37a-7d9d-9f10-c2ecba98e742",
      slug: "KXBTCD-26JUL2217-T67500",
      title: "Bitcoin price range",
      sourceExchange: null,
      outcomes: [
        { outcomeId: "KXBTCD-26JUL2217-T67500", label: "$67,500 or above" },
        { outcomeId: "KXBTCD-26JUL2217-T67500-NO", label: "Not $67,500 or above" },
      ],
    } as unknown as PmxtMarket;

    const snapshot = mapPmxtMarketToSnapshot(unified, capturedAt, {
      sourceExchange: "kalshi",
      nativeMarketIdentity: { kind: "ticker", value: "KXBTCD-26JUL2217-T67500" },
      outcomeOrientation: {
        yesOutcomeId: "KXBTCD-26JUL2217-T67500",
        noOutcomeId: "KXBTCD-26JUL2217-T67500-NO",
      },
    });

    expect(snapshot).toMatchObject({
      catalogMarketId: "01982c2b-a37a-7d9d-9f10-c2ecba98e742",
      venueMarketId: "KXBTCD-26JUL2217-T67500",
      sourceExchange: "kalshi",
    });
    expect(snapshot.rawPayload).toMatchObject({
      yesOutcomeId: "KXBTCD-26JUL2217-T67500",
      noOutcomeId: "KXBTCD-26JUL2217-T67500-NO",
    });
  });

  it("preserves an explicitly stamped Polymarket conditionId instead of its slug", () => {
    const unified = {
      marketId: "01982c2b-a37a-7d9d-9f10-c2ecba98e743",
      slug: "will-btc-rise",
      contractAddress: "0x1234567890abcdef",
      title: "Will BTC rise?",
      sourceExchange: null,
      outcomes: [
        { outcomeId: "token-yes", label: "BTC rises" },
        { outcomeId: "token-no", label: "BTC does not rise" },
      ],
    } as unknown as PmxtMarket;

    const snapshot = mapPmxtMarketToSnapshot(unified, capturedAt, {
      sourceExchange: "polymarket",
      nativeMarketIdentity: { kind: "conditionId", value: "0x1234567890abcdef" },
      outcomeOrientation: { yesOutcomeId: "token-yes", noOutcomeId: "token-no" },
    });

    expect(snapshot.catalogMarketId).toBe("01982c2b-a37a-7d9d-9f10-c2ecba98e743");
    expect(snapshot.venueMarketId).toBe("0x1234567890abcdef");
    expect(snapshot.venueMarketId).not.toBe(unified.slug);
    expect(snapshot.sourceExchange).toBe("polymarket");
  });

  it("does not allow a Polymarket slug to masquerade as a conditionId", () => {
    const unified = {
      marketId: "catalog-id",
      slug: "fake-condition-id",
      sourceExchange: null,
      outcomes: [
        { outcomeId: "token-yes", label: "Yes" },
        { outcomeId: "token-no", label: "No" },
      ],
    } as unknown as PmxtMarket;

    expect(() => mapPmxtMarketToSnapshot(unified, capturedAt, {
      sourceExchange: "polymarket",
      nativeMarketIdentity: { kind: "conditionId", value: "fake-condition-id" },
      outcomeOrientation: { yesOutcomeId: "token-yes", noOutcomeId: "token-no" },
    })).toThrow("PMXT Polymarket conditionId is not proven by the market payload");
  });

  it("fails closed for venue-native labels without explicit YES/NO orientation", () => {
    const unified = {
      marketId: "catalog-id",
      sourceExchange: null,
      outcomes: [
        { outcomeId: "a", label: "$67,500 or above" },
        { outcomeId: "b", label: "Not $67,500 or above" },
      ],
    } as unknown as PmxtMarket;

    expect(() => mapPmxtMarketToSnapshot(unified, capturedAt, {
      sourceExchange: "kalshi",
      nativeMarketIdentity: { kind: "ticker", value: "KXBTCD-26JUL2217-T67500" },
    })).toThrow("PMXT outcome orientation is ambiguous");
  });
});
