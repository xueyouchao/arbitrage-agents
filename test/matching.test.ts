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

  it("allows crypto price-level deadlines within the relaxed 24 h tolerance by default", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-02T15:59:00.000Z" })
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("k-1:p-1");
  });

  it("rejects crypto price-level deadlines outside the relaxed tolerance", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-03T16:01:00.000Z" })
    ]);

    expect(pairs).toEqual([]);
  });

  it("honours a custom deadline tolerance", () => {
    const pairs = new CandidatePairGenerator({
      deadlineTolerance: {
        defaultDeadlineToleranceMs: 60_000,
        cryptoDeadlineRelaxedToleranceMs: 7 * 24 * 60 * 60 * 1000
      }
    }).generate([
      market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-07T16:00:00.000Z" })
    ]);

    expect(pairs).toHaveLength(1);
  });

  it("rejects crypto price-level deadlines just outside a custom tolerance window", () => {
    const pairs = new CandidatePairGenerator({
      deadlineTolerance: {
        defaultDeadlineToleranceMs: 60_000,
        cryptoDeadlineRelaxedToleranceMs: 7 * 24 * 60 * 60 * 1000
      }
    }).generate([
      market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      market({ id: "p-1", venue: "polymarket", deadline: "2026-01-08T16:00:01.000Z" })
    ]);

    expect(pairs).toEqual([]);
  });

  it("keeps exact 60 s tolerance for non-crypto deadlines", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({
        id: "k-1",
        venue: "kalshi",
        topic: "politics",
        eventType: "winner",
        threshold: undefined,
        operator: undefined,
        deadline: "2026-01-01T00:00:00.000Z"
      }),
      market({
        id: "p-1",
        venue: "polymarket",
        topic: "politics",
        eventType: "winner",
        threshold: undefined,
        operator: undefined,
        deadline: "2026-01-01T00:01:01.000Z"
      })
    ]);

    expect(pairs).toEqual([]);
  });

  // Regression: the candidate generator previously bucketed threshold-bearing
  // markets by topic|asset|eventType|payoffType only, collapsing every strike
  // on a given crypto day into one bucket and producing an O(strikes^2)
  // cross-product. The band-expansion bucket keeps a near-cross-product from
  // forming while still admitting every within-$1 strike pair — including a
  // pair that straddles a $1 band boundary.
  it("admits a within-$1 crypto strike pair that straddles a $1 band boundary", () => {
    // 52000.49 (band 52000) and 52001.49 (band 52001) are exactly $1.00 apart
    // and thus within the <=$1 tolerance, but land in different $1 bands.
    // Band expansion (floor and floor+1) must still surface this pair.
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi", venueMarketId: "K1", threshold: 52000.49 }),
      market({ id: "p-1", venue: "polymarket", venueMarketId: "P1", threshold: 52001.49 })
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].id).toBe("k-1:p-1");
  });

  it("does not cross-product every strike on the same crypto day", () => {
    // 20 kalshi strikes and 20 polymarket strikes, all on the same day, each
    // $500 apart. Only strikes within $1 should pair — with the old single
    // bucket every kalshi struck every polymarket candidate (400 candidates
    // funneled through thresholdsMatch); with band expansion each kalshi
    // market collides with at most a handful of polymarket markets in the
    // same $1 band, and only the within-$1 pair survives isCandidate.
    const kalshi = Array.from({ length: 20 }, (_, i) =>
      market({ id: `k-${i}`, venue: "kalshi", venueMarketId: `K${i}`, threshold: 60000 + i * 500 })
    );
    const polymarket = Array.from({ length: 20 }, (_, i) =>
      market({ id: `p-${i}`, venue: "polymarket", venueMarketId: `P${i}`, threshold: 60000.5 + i * 500 })
    );

    const pairs = new CandidatePairGenerator().generate([...kalshi, ...polymarket]);

    // Each kalshi strike pairs with exactly one polymarket strike (the one
    // $0.50 away). No cross-product: 20 pairs, not 400.
    expect(pairs).toHaveLength(20);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(20);
    for (const pair of pairs) {
      expect(Math.abs(pair.kalshiMarket.threshold! - pair.polymarketMarket.threshold!)).toBeLessThanOrEqual(1);
    }
  });

  it("does not pair crypto strikes more than $1 apart even on the same day", () => {
    const pairs = new CandidatePairGenerator().generate([
      market({ id: "k-1", venue: "kalshi", venueMarketId: "K1", threshold: 60000 }),
      market({ id: "p-1", venue: "polymarket", venueMarketId: "P1", threshold: 65000 })
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

  it("classifies crypto price-level deadlines within relaxed tolerance as tradable class A with advisory reason", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", deadline: "2026-01-02T15:59:00.000Z" }),
      reasons: []
    };

    expect(new DeterministicEquivalencePolicy().classify(pair)).toMatchObject({
      equivalenceClass: "A",
      decision: "tradable",
      reasons: ["deadline_within_relaxed_tolerance"]
    });
  });

  it("rejects crypto price-level deadlines outside relaxed tolerance", () => {
    const pair = {
      id: "k-1:p-1",
      kalshiMarket: market({ id: "k-1", venue: "kalshi", deadline: "2026-01-01T16:00:00.000Z" }),
      polymarketMarket: market({ id: "p-1", venue: "polymarket", deadline: "2026-01-02T17:00:01.000Z" }),
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
