import { PmxtMarket } from "../../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";

export const capturedAt = "2026-07-15T12:00:00.000Z";

export const binaryYesNoMarket: PmxtMarket = {
  id: "pmxt-m1",
  title: "Will Bitcoin be above $100,000 on Jan 1, 2026?",
  description: "Resolves to YES if Coinbase BTC/USD print is >= $100,000 at 2026-01-01T00:00:00Z.",
  outcomes: [
    { id: "o1", label: "Yes" },
    { id: "o2", label: "No" },
  ],
};

export const marketWithNoDescription: PmxtMarket = {
  id: "pmxt-m2",
  title: "",
  outcomes: [
    { id: "o3", label: "Yes" },
    { id: "o4", label: "No" },
  ],
};

export const marketWithUnknownFields: PmxtMarket = {
  ...binaryYesNoMarket,
  sourceExchange: "polymarket",
  extraField: "surprise",
};

export const marketMissingId: PmxtMarket = {
  id: "",
  title: "Missing id",
  outcomes: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }],
};

export const marketNoOutcomes: PmxtMarket = {
  id: "pmxt-no-outcomes",
  title: "No outcomes",
  outcomes: [],
};

export const marketNonBinary: PmxtMarket = {
  id: "pmxt-non-binary",
  title: "Non-binary",
  outcomes: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
};

export const marketAmbiguousOutcomeId: PmxtMarket = {
  id: "pmxt-ambiguous-id",
  title: "Ambiguous id",
  outcomes: [{ id: "o1", label: "Yes" }, { id: "", label: "No" }],
};

export const marketAmbiguousOrientation: PmxtMarket = {
  id: "pmxt-ambiguous-orientation",
  title: "Ambiguous orientation",
  outcomes: [
    { id: "up", label: "Up" },
    { id: "down", label: "Down" },
  ],
};

export const marketYesNoLowercase: PmxtMarket = {
  id: "pmxt-lowercase",
  title: "Lowercase labels",
  outcomes: [
    { id: "y", label: "yes" },
    { id: "n", label: "no" },
  ],
};

export const marketMixedCaseYesNo: PmxtMarket = {
  id: "pmxt-mixed-case",
  title: "Mixed case labels",
  outcomes: [
    { id: "y", label: "YES" },
    { id: "n", label: "NO" },
  ],
};
