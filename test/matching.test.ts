import { describe, expect, it } from "vitest";
import { CandidatePairGenerator } from "../src/contexts/matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../src/contexts/matching/domain/equivalence-policy";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";

const baseMarket: NormalizedMarket = {
  id: "base",
  venue: "kalshi",
  venueMarketId: "base",
  title: "Will BTC be above 100000 on Jan 1?",
  rawResolutionText: "Resolves using Coinbase BTC USD at deadline",
  topic: "crypto",
  eventType: "price_above",
  asset: "BTC",
  threshold: 100000,
  operator: ">",
  deadline: "2026-01-01T00:00:00.000Z",
  timezone: "UTC",
  resolutionSource: "Coinbase BTC/USD",
  payoffType: "at_time",
  ambiguityFlags: [],
  confidence: 0.95
};

function market(overrides: Partial<NormalizedMarket>): NormalizedMarket {
  return { ...baseMarket, ...overrides };
}

describe("CandidatePairGenerator", () => {
  it("generates cross-venue candidates only when deterministic filters match", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi", venueMarketId: "K1" }),
      market({ id: "p-1", venue: "polymarket", venueMarketId: "P1" }),
      market({ id: "p-2", venue: "polymarket", venueMarketId: "P2", threshold: 110000 }),
      market({ id: "p-3", venue: "polymarket", venueMarketId: "P3", asset: "ETH" })
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("k-1:p-1");
    expect(pairs[0].reasons).toContain("same_asset");
  });

  it("allows crypto price-level deadlines on the same UTC day even when hours apart", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-01T02:00:01.000Z" })
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("k-1:p-1");
  });

  it("still rejects crypto price-level deadlines on different UTC days", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-02T00:00:00.000Z" })
    ]);

    expect(pairs).toEqual([]);
  });
});

describe("DeterministicEquivalencePolicy", () => {
  it("classifies exact deterministic matches as tradable class A", () => {
    const [pair] = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi" }),
      market({ id: "p-1", venue: "polymarket" })
    ]);

    expect(new DeterministicEquivalencePolicy().classify(pair)).toEqual({
      pairId: "k-1:p-1",
      equivalenceClass: "A",
      decision: "tradable",
      reasons: ["deterministic_fields_match"]
    });
  });

  it("keeps ambiguous or source-different matches alert-only class B", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({
        id: "k-1",
        venue: "kalshi",
        topic: "politics",
        eventType: "winner",
        asset: "Candidate A",
        threshold: undefined,
        operator: undefined,
        ambiguityFlags: ["timezone_in_title"]
      }),
      polymarketMarket: market({
        id: "p-1",
        venue: "polymarket",
        topic: "politics",
        eventType: "winner",
        asset: "Candidate A",
        threshold: undefined,
        operator: undefined,
        resolutionSource: "Binance BTC/USDT"
      }),
      reasons: []
    };

    const decision = new DeterministicEquivalencePolicy().classify(pair);

    expect(decision.equivalenceClass).toBe("B");
    expect(decision.decision).toBe("alert_only");
    expect(decision.reasons).toEqual(["ambiguity_flags_present", "resolution_source_differs"]);
  });

  it("classifies crypto price-level index source differences as tradable class A", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({
        id: "k-1",
        venue: "kalshi",
        threshold: 52000,
        resolutionSource: "CF Benchmarks Real-Time Index"
      }),
      polymarketMarket: market({
        id: "p-1",
        venue: "polymarket",
        threshold: 52000,
        resolutionSource: "Binance BTC/USDT"
      }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toEqual({
      pairId: "k-1:p-1",
      equivalenceClass: "A",
      decision: "tradable",
      reasons: ["resolution_source_differs_crypto_index"]
    });
  });

  it("classifies same-day crypto price-level deadline differences as tradable class A with advisory reason", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", deadline: "2026-01-01T16:59:00.000Z" }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "A",
      decision: "tradable",
      reasons: ["deadline_same_day_time_differs"]
    });
  });

  it("rejects crypto price-level deadlines on different UTC days", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", deadline: "2026-01-02T16:00:00.000Z" }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["deadline_mismatch"]
    });
  });

  it("allows crypto price-level thresholds within $1 as tradable class A with advisory reason", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", threshold: 51999.99 }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", threshold: 52000 }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "A",
      decision: "tradable",
      reasons: ["threshold_close_but_not_identical"]
    });
  });

  it("rejects crypto price-level thresholds more than $1 apart", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", threshold: 51000 }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", threshold: 52000 }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["threshold_mismatch"]
    });
  });

  it("rejects operator mismatches", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", operator: ">" }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", operator: ">=" }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "C",
      decision: "reject",
      reasons: ["operator_mismatch"]
    });
  });

  it("treats undefined thresholds as compatible for sports/winner markets", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", threshold: undefined, eventType: "winner", asset: "Chiefs", operator: undefined }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", threshold: undefined, eventType: "winner", asset: "Chiefs", operator: undefined }),
      reasons: []
    };

    const decision = new DeterministicEquivalencePolicy().classify(pair);

    expect(decision.decision).toBe("tradable");
    expect(decision.reasons).not.toContain("threshold_mismatch");
  });
});
