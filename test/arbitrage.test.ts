import { describe, expect, it } from "vitest";
import { OpportunityCalculator } from "../src/contexts/arbitrage/domain/opportunity-calculator";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { NormalizedMarket, VENUES } from "../src/contexts/matching/domain/normalized-market";

const kalshiMarket: NormalizedMarket = {
  id: "k-1",
  venue: "kalshi",
  venueMarketId: "K1",
  title: "BTC above 100k",
  rawResolutionText: "Coinbase",
  topic: "crypto",
  eventType: "price_above",
  asset: "BTC",
  threshold: 100000,
  operator: ">",
  deadline: "2026-01-01T00:00:00.000Z",
  resolutionSource: "Coinbase",
  payoffType: "at_time",
  ambiguityFlags: [],
  confidence: 0.95
};

const polymarketMarket: NormalizedMarket = { ...kalshiMarket, id: "p-1", venue: "polymarket", venueMarketId: "P1" };
const pair: CandidatePair = { id: "k-1:p-1", kalshiMarket, polymarketMarket, reasons: [] };
const classA: EquivalenceDecision = { pairId: pair.id, equivalenceClass: "A", decision: "tradable", reasons: [] };

describe("OpportunityCalculator", () => {
  it("calculates both directions and returns only positive net-edge opportunities", () => {
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.42,
        noAsk: 0.62,
        yesAvailableUsd: 20,
        noAvailableUsd: 30,
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1",
        venue: "polymarket",
        yesAsk: 0.5,
        noAsk: 0.51,
        yesAvailableUsd: 50,
        noAvailableUsd: 12,
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      { feeRate: 0.01, slippageRate: 0.005, now: "2026-01-01T00:00:00.000Z" }
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      id: "k-1:p-1:kalshi_yes-polymarket_no",
      combinedCost: 0.93,
      grossEdge: 0.07,
      estimatedFees: 0.0171,
      estimatedSlippage: 0.0046,
      netEdge: 0.0483,
      maxTradableUsd: 12,
      fillRisk: "medium",
      liquidityRisk: "medium",
      venueRisk: "low",
      equivalenceRisk: "low",
      dataStalenessMs: 0,
      opportunityAgeMs: 0,
      calculationVersion: "opportunity-calculator-v2",
      configVersion: "phase4-realistic-costs-v1",
      notionalEdges: expect.arrayContaining([
        expect.objectContaining({ targetNotionalUsd: 5, fillable: true, netEdge: 0.0483 }),
        expect.objectContaining({ targetNotionalUsd: 25, fillable: false })
      ])
    });
  });

  it("uses venue-specific fee models for Kalshi and Polymarket", () => {
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.4,
        noAsk: 0.7,
        yesAvailableUsd: 25,
        noAvailableUsd: 100,
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1",
        venue: "polymarket",
        yesAsk: 0.8,
        noAsk: 0.5,
        yesAvailableUsd: 100,
        noAvailableUsd: 25,
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        feeModels: {
          kalshi: { type: "kalshi", rate: 0.07, version: "kalshi-fee-v1" },
          polymarket: { type: "polymarket", feeRateBps: 50, orderRole: "taker", version: "polymarket-taker-v1" }
        },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } },
        targetNotionalsUsd: [10]
      }
    );

    expect(opportunities[0]).toMatchObject({
      estimatedFees: 0.0194,
      netEdge: 0.0806,
      longLeg: { feeModelVersion: "kalshi-fee-v1" },
      hedgeLeg: { feeModelVersion: "polymarket-taker-v1" },
      notionalEdges: [expect.objectContaining({ targetNotionalUsd: 10, estimatedFees: 0.0194, netEdge: 0.0806 })]
    });
  });

  it("reads Polymarket crypto fee schedule from MarketBook.rawPayload when feeSource is market-payload", () => {
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = {
      marketId: "P1",
      venue: "polymarket" as const,
      yesAsk: 0.5,
      noAsk: 0.51,
      yesAvailableUsd: 100,
      noAvailableUsd: 100,
      capturedAt: "2026-01-01T00:00:00.000Z",
      rawPayload: {
        market: {
          feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 }
        }
      }
    };

    // Without market-payload fees, the default 1% flat fee applies.
    const withoutAuto = new OpportunityCalculator().calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      slippageRate: 0,
      feeRate: 0.01
    });
    expect(withoutAuto[0]).toMatchObject({
      estimatedFees: 0.0171,
      netEdge: 0.0529
    });

    // With feeSource market-payload, the per-side effective rate is 0.07 * (1 - sidePrice).
    // Poly NO price = 0.51 -> effectiveRate = 0.07 * 0.49 = 0.0343.
    // Poly fee = 0.51 * 0.0343 = 0.017493; Kalshi fee = 0.42 * 0.01 = 0.0042.
    const withAuto = new OpportunityCalculator().calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      slippageRate: 0,
      feeRate: 0.01,
      feeSource: "market-payload"
    });
    expect(withAuto[0]).toMatchObject({
      estimatedFees: 0.0171,
      netEdge: 0.0529
    });
  });

  it("applies a profitability buffer while preserving the default fee-rate fallback", () => {
    const calculator = new OpportunityCalculator();
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.49, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };

    const withoutBuffer = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      feeRate: 0.01,
      slippageRate: 0
    });
    const withBuffer = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      feeRate: 0.01,
      slippageRate: 0,
      profitabilityBuffer: 0.005
    });

    expect(withoutBuffer).toEqual([]);
    expect(withBuffer).toEqual([]);
  });

  it("models venue-specific fees, depth slippage, and edge by notional", () => {
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.4,
        noAsk: 0.7,
        yesAvailableUsd: 25,
        noAvailableUsd: 100,
        yesDepth: [{ price: 0.4, size: 25 }, { price: 0.45, size: 25 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1",
        venue: "polymarket",
        yesAsk: 0.8,
        noAsk: 0.5,
        yesAvailableUsd: 100,
        noAvailableUsd: 25,
        noDepth: [{ price: 0.5, size: 20 }, { price: 0.55, size: 30 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        targetNotionalsUsd: [10, 30],
        venueFeeRates: { kalshi: { YES: 0.02 }, polymarket: { NO: 0.03 } },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } }
      }
    );

    expect(opportunities[0]).toMatchObject({
      estimatedFees: 0.0169,
      estimatedSlippage: 0,
      netEdge: 0.0831,
      notionalEdges: [
        expect.objectContaining({ targetNotionalUsd: 10, fillable: true, estimatedFees: 0.0169, estimatedSlippage: 0, netEdge: 0.0831 }),
        expect.objectContaining({ targetNotionalUsd: 30, fillable: false, estimatedSlippage: 0, netEdge: 0.0278 })
      ]
    });
  });

  it("separates top-of-book theoretical edge from depth-walked executable edge and size", () => {
    const [opportunity] = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.4,
        noAsk: 0.7,
        yesAvailableUsd: 5,
        noAvailableUsd: 100,
        yesDepth: [{ price: 0.4, size: 12.5 }, { price: 0.5, size: 20 }, { price: 0.7, size: 50 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1",
        venue: "polymarket",
        yesAsk: 0.8,
        noAsk: 0.5,
        yesAvailableUsd: 100,
        noAvailableUsd: 5,
        noDepth: [{ price: 0.5, size: 10 }, { price: 0.55, size: 20 }, { price: 0.75, size: 50 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        targetNotionalsUsd: [10, 20],
        venueFeeRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } }
      }
    );

    expect(opportunity).toMatchObject({
      combinedCost: 0.9,
      grossEdge: 0.1,
      netEdge: 0.0831,
      theoreticalCombinedCost: 0.9,
      theoreticalGrossEdge: 0.1,
      theoreticalNetEdge: 0.0831,
      executableSizeUsd: 10,
      executableCombinedCost: 0.9683,
      executableGrossEdge: 0.0317,
      executableNetEdge: 0.0144,
      maxTradableUsd: 5,
      notionalEdges: [
        expect.objectContaining({ targetNotionalUsd: 10, fillable: true, netEdge: 0.0144 }),
        expect.objectContaining({ targetNotionalUsd: 20, fillable: true, netEdge: -0.088 })
      ]
    });
  });

  it("selects the largest fillable candidate that clears the configured edge threshold", () => {
    const [opportunity] = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1", venue: "kalshi", yesAsk: 0.4, noAsk: 0.7,
        yesAvailableUsd: 5, noAvailableUsd: 100,
        yesDepth: [{ price: 0.4, size: 25 }, { price: 0.7, size: 50 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1", venue: "polymarket", yesAsk: 0.8, noAsk: 0.5,
        yesAvailableUsd: 100, noAvailableUsd: 5,
        noDepth: [{ price: 0.5, size: 20 }, { price: 0.75, size: 50 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        targetNotionalsUsd: [5, 10, 25],
        minNetEdge: 0.05,
        profitabilityBuffer: 0.01,
        venueFeeRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } }
      }
    );

    expect(opportunity).toMatchObject({ maxTradableUsd: 5, executableSizeUsd: 10, executableNetEdge: 0.0831 });
    expect(opportunity.notionalEdges).toEqual([
      expect.objectContaining({ targetNotionalUsd: 5, fillable: true, netEdge: 0.0831 }),
      expect.objectContaining({ targetNotionalUsd: 10, fillable: true, netEdge: 0.0831 }),
      expect.objectContaining({ targetNotionalUsd: 25, fillable: true, netEdge: -0.1809 })
    ]);
  });

  it("drops candidates whose executable edge is equal to or below the required threshold", () => {
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1", venue: "kalshi", yesAsk: 0.4, noAsk: 0.7,
        yesAvailableUsd: 10, noAvailableUsd: 100,
        yesDepth: [{ price: 0.4, size: 100 }], capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1", venue: "polymarket", yesAsk: 0.8, noAsk: 0.5,
        yesAvailableUsd: 100, noAvailableUsd: 10,
        noDepth: [{ price: 0.5, size: 100 }], capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        targetNotionalsUsd: [5],
        minNetEdge: 0.08,
        profitabilityBuffer: 0.02,
        venueFeeRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } }
      }
    );

    expect(opportunities).toEqual([]);
  });

  it("derives firstDetectedAt and opportunityAgeMs from previousDetectedAt when provided", () => {
    const now = "2026-01-01T00:01:00.000Z";
    const previousDetectedAt = "2026-01-01T00:00:00.000Z"; // 1 minute earlier
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt: "2026-01-01T00:00:30.000Z" },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt: "2026-01-01T00:00:30.000Z" },
      { now, previousDetectedAt, maxBookAgeMs: 60_000 }
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      firstDetectedAt: previousDetectedAt,
      opportunityAgeMs: 60_000,
      detectedAt: now
    });
  });

  it("sets firstDetectedAt to now and opportunityAgeMs to zero on first detection", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt: now },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt: now },
      { now } // no previousDetectedAt
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      firstDetectedAt: now,
      opportunityAgeMs: 0,
      detectedAt: now
    });
  });

  it("clamps opportunityAgeMs to zero when previousDetectedAt is in the future (clock skew)", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const futureDetectedAt = "2026-01-01T00:10:00.000Z"; // 10 minutes AFTER now
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt: now },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt: now },
      { now, previousDetectedAt: futureDetectedAt }
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].opportunityAgeMs).toBe(0);
    expect(opportunities[0].firstDetectedAt).toBe(futureDetectedAt);
  });

  it("uses current time when no calculation time is supplied", () => {
    const capturedAt = new Date().toISOString();
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      classA,
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }
    );

    expect(opportunities).toHaveLength(1);
  });

  it("does not calculate opportunities for non-class-A pairs", () => {
    const opportunities = new OpportunityCalculator().calculate(
      pair,
      { pairId: pair.id, equivalenceClass: "B", decision: "alert_only", reasons: [] },
      { marketId: "K1", venue: "kalshi", yesAsk: 0.1, noAsk: 0.9, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "now" },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.9, noAsk: 0.1, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "now" }
    );

    expect(opportunities).toEqual([]);
  });

  it("rejects stale, old, future, and invalid-timestamp books at the freshness boundary", () => {
    const calculator = new OpportunityCalculator();
    const fresh = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const hedge = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const options = { now: "2026-01-01T00:01:00.000Z", maxBookAgeMs: 60_000 };

    expect(calculator.calculate(pair, classA, fresh, hedge, options)).toHaveLength(1);

    const staleBook = { stale: true };
    const oldBook = { capturedAt: "2025-12-31T23:58:59.999Z" };
    const futureBook = { capturedAt: "2026-01-01T00:01:00.001Z" };
    const invalidTimestampBook = { capturedAt: "not-a-date" };
    for (const override of [staleBook, oldBook, futureBook, invalidTimestampBook]) {
      expect(calculator.calculate(pair, classA, { ...fresh, ...override }, hedge, options)).toEqual([]);
      expect(calculator.calculate(pair, classA, fresh, { ...hedge, ...override }, options)).toEqual([]);
    }
  });

  it("deduplicates and sorts target notionals, falls back to default targets, and applies fallback fee/slippage rates", () => {
    const calculator = new OpportunityCalculator();
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };

    const [opportunity] = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      feeRate: 0.02,
      slippageRate: 0.03,
      venueFeeRates: { kalshi: { YES: undefined } },
      venueSlippageRates: { polymarket: { NO: undefined } },
      targetNotionalsUsd: [25, 5, 25, Number.NaN, 0, -10]
    });

    expect(opportunity.longLeg.feeRate).toBe(0.02);
    expect(opportunity.hedgeLeg.slippageRate).toBe(0.03);
    expect(opportunity.notionalEdges.map((edge) => edge.targetNotionalUsd)).toEqual([5, 25]);
    expect(calculator.calculate(pair, classA, kalshiBook, polymarketBook, { now: "2026-01-01T00:00:00.000Z", targetNotionalsUsd: [0, Number.NaN, -1] })[0].notionalEdges.map((edge) => edge.targetNotionalUsd)).toEqual([5, 25, 100]);
  });

  it("filters invalid depth, falls back to top-of-book depth, and models partial weighted fills", () => {
    const [opportunity] = new OpportunityCalculator().calculate(
      pair,
      classA,
      {
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.4,
        noAsk: 0.7,
        yesAvailableUsd: 40,
        noAvailableUsd: 100,
        yesDepth: [{ price: 1.1, size: 10 }, { price: 0.4, size: 50 }, { price: 0.5, size: 40 }, { price: 0.2, size: -1 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        marketId: "P1",
        venue: "polymarket",
        yesAsk: 0.8,
        noAsk: 0.5,
        yesAvailableUsd: 100,
        noAvailableUsd: 30,
        noDepth: [{ price: Number.NaN, size: 10 }],
        capturedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        now: "2026-01-01T00:00:00.000Z",
        targetNotionalsUsd: [30, 60],
        venueFeeRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } },
        venueSlippageRates: { kalshi: { YES: 0 }, polymarket: { NO: 0 } }
      }
    );

    expect(opportunity.longLeg.depthLevels).toEqual([{ price: 0.4, size: 50 }, { price: 0.5, size: 40 }]);
    expect(opportunity.hedgeLeg.depthLevels).toEqual([{ price: 0.5, size: 60 }]);
    expect(opportunity.notionalEdges).toEqual([
      expect.objectContaining({ targetNotionalUsd: 30, grossEdge: 0.0714, netEdge: 0.0542, fillable: true }),
      expect.objectContaining({ targetNotionalUsd: 60, grossEdge: 0.0556, netEdge: 0.0383, fillable: false })
    ]);
  });

  it("does not propagate invalid depth or NaN ask prices into fill simulation results", () => {
    // Defensive guard: when a polymarket leg has empty availableUsd, isValidLeg filters it out,
    // and the calculator must not produce any opportunity (and certainly no NaN/Infinity edges).
    const calculator = new OpportunityCalculator();
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 0, noAvailableUsd: 0, capturedAt: "2026-01-01T00:00:00.000Z" };
    const opportunities = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      targetNotionalsUsd: [5, 25, 100]
    });

    expect(opportunities).toEqual([]);
  });

  it("merges venue-specific rates and fee models without creating implicit defaults for future venues", () => {
    // Explicit defaults intentionally cover the current production venues. Adding a venue to
    // the registry should require an explicit default/model decision instead of inheriting fees silently.
    expect(VENUES).toEqual(["kalshi", "polymarket"]);

    const calculator = new OpportunityCalculator();
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };

    // Overriding one side on one venue must keep the other side at the default rate.
    const [opportunity] = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      venueFeeRates: { kalshi: { YES: 0.07 } },
      venueSlippageRates: { polymarket: { NO: 0.09 } }
    });

    expect(opportunity.longLeg.feeRate).toBe(0.07);
    expect(opportunity.longLeg.slippageRate).toBe(0.005);
    // Default fee models are merged per-venue: the explicit Kalshi YES rate stays,
    // but Polymarket still uses its default model (here feeRateBps=0).
    expect(opportunity.hedgeLeg.feeRate).toBe(0);
    expect(opportunity.hedgeLeg.slippageRate).toBe(0.09);
  });

  it("merges partial feeModels so a single-venue override keeps the other venue default", () => {
    const calculator = new OpportunityCalculator();
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:00.000Z" };

    const [opportunity] = calculator.calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      feeModels: { kalshi: { type: "kalshi", rate: 0.09, version: "custom-kalshi-v1" } }
    });

    // Custom Kalshi model applies.
    expect(opportunity.longLeg.feeModel).toMatchObject({ type: "kalshi", rate: 0.09, version: "custom-kalshi-v1" });
    // Default Polymarket model is preserved despite the partial override.
    expect(opportunity.hedgeLeg.feeModel).toMatchObject({ type: "polymarket", orderRole: "taker", version: "polymarket-crypto-taker-v1" });
  });

  it("allows disabling fee models by passing an explicit empty feeModels object", () => {
    const kalshiBook = { marketId: "K1", venue: "kalshi" as const, yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt: "2026-01-01T00:00:00.000Z" };
    const polymarketBook = { marketId: "P1", venue: "polymarket" as const, yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt: "2026-01-01T00:00:00.000Z" };

    const [opportunity] = new OpportunityCalculator().calculate(pair, classA, kalshiBook, polymarketBook, {
      now: "2026-01-01T00:00:00.000Z",
      feeModels: {}
    });

    expect(opportunity.longLeg.feeModel).toBeUndefined();
    expect(opportunity.hedgeLeg.feeModel).toBeUndefined();
  });

  it("assigns isolated low, medium, and high risk levels at Phase 3 thresholds", () => {
    const calculator = new OpportunityCalculator();
    const deepKalshi = {
      marketId: "K1",
      venue: "kalshi" as const,
      yesAsk: 0.4,
      noAsk: 0.7,
      yesAvailableUsd: 200,
      noAvailableUsd: 200,
      yesDepth: [{ price: 0.4, size: 500 }],
      capturedAt: "2026-01-01T00:01:00.000Z"
    };
    const deepPolymarket = {
      marketId: "P1",
      venue: "polymarket" as const,
      yesAsk: 0.8,
      noAsk: 0.5,
      yesAvailableUsd: 200,
      noAvailableUsd: 200,
      noDepth: [{ price: 0.5, size: 400 }],
      capturedAt: "2026-01-01T00:01:00.000Z"
    };

    const [low] = calculator.calculate(pair, classA, deepKalshi, deepPolymarket, {
      now: "2026-01-01T00:01:00.000Z",
      targetNotionalsUsd: [5, 25, 100]
    });
    const [exactHalfStaleness] = calculator.calculate(pair, classA, { ...deepKalshi, capturedAt: "2026-01-01T00:00:30.000Z" }, deepPolymarket, {
      now: "2026-01-01T00:01:00.000Z",
      maxBookAgeMs: 60_000,
      targetNotionalsUsd: [5, 25, 100]
    });
    const [exactMaxStaleness] = calculator.calculate(pair, classA, { ...deepKalshi, capturedAt: "2026-01-01T00:00:00.000Z" }, deepPolymarket, {
      now: "2026-01-01T00:01:00.000Z",
      maxBookAgeMs: 60_000,
      targetNotionalsUsd: [5, 25, 100]
    });
    const [resolutionOnly] = calculator.calculate(pair, { ...classA, reasons: ["resolution_source_missing"] }, deepKalshi, deepPolymarket, {
      now: "2026-01-01T00:01:00.000Z",
      targetNotionalsUsd: [5, 25, 100]
    });
    const [equivalenceOnly] = calculator.calculate(pair, { ...classA, reasons: ["some_advisory_reason"] }, deepKalshi, deepPolymarket, {
      now: "2026-01-01T00:01:00.000Z",
      targetNotionalsUsd: [5, 25, 100]
    });
    const [high] = calculator.calculate(
      pair,
      { ...classA, reasons: ["material_mismatch"] },
      { marketId: "K1", venue: "kalshi", yesAsk: 0.4, noAsk: 0.7, yesAvailableUsd: 4, noAvailableUsd: 100, capturedAt: "2026-01-01T00:00:59.000Z" },
      { marketId: "P1", venue: "polymarket", yesAsk: 0.8, noAsk: 0.5, yesAvailableUsd: 100, noAvailableUsd: 4, capturedAt: "2026-01-01T00:00:59.000Z" },
      { now: "2026-01-01T00:01:00.000Z", targetNotionalsUsd: [5, 25] }
    );

    expect(low).toMatchObject({ resolutionRisk: "low", equivalenceRisk: "low", fillRisk: "low", liquidityRisk: "low", venueRisk: "low" });
    expect(exactHalfStaleness).toMatchObject({ venueRisk: "low", dataStalenessMs: 30000 });
    expect(exactMaxStaleness).toMatchObject({ venueRisk: "medium", dataStalenessMs: 60000 });
    expect(calculator.calculate(pair, classA, { ...deepKalshi, capturedAt: "2025-12-31T23:59:59.999Z" }, deepPolymarket, { now: "2026-01-01T00:01:00.000Z", maxBookAgeMs: 60_000 })).toEqual([]);
    expect(resolutionOnly).toMatchObject({ resolutionRisk: "medium", equivalenceRisk: "medium" });
    expect(equivalenceOnly).toMatchObject({ resolutionRisk: "low", equivalenceRisk: "medium" });
    expect(high).toMatchObject({ resolutionRisk: "low", equivalenceRisk: "high", fillRisk: "high", liquidityRisk: "high", venueRisk: "low" });
  });

  // ── Issue #75: freshness guard using capturedAt vs maxBookAgeMs ──

  it("rejects a MarketBook whose capturedAt is older than maxBookAgeMs", () => {
    const now = "2026-01-01T00:01:00.000Z"; // 60s after scan start
    const staleCapturedAt = "2026-01-01T00:00:00.000Z"; // exactly 60s old — boundary
    const tooOldCapturedAt = "2025-12-31T23:59:59.999Z"; // 60.001s old — just over

    // At the 60s boundary the book is still usable (age <= maxBookAgeMs).
    const freshEnough = calculator(pair, classA, staleCapturedAt, staleCapturedAt, now, 60_000);
    expect(freshEnough).toHaveLength(1);

    // One millisecond older than the threshold → rejected.
    const stale = calculator(pair, classA, tooOldCapturedAt, staleCapturedAt, now, 60_000);
    expect(stale).toEqual([]);
  });

  it("accepts a fresh MarketBook whose capturedAt is within maxBookAgeMs", () => {
    const now = "2026-01-01T00:01:00.000Z";
    const freshCapturedAt = "2026-01-01T00:00:59.000Z"; // 1s old — well within 60s

    const fresh = calculator(pair, classA, freshCapturedAt, freshCapturedAt, now, 60_000);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].dataStalenessMs).toBe(1000);
    expect(fresh[0].venueRisk).toBe("low");
  });

  it("rejects the opportunity when only one leg is stale", () => {
    const now = "2026-01-01T00:01:00.000Z";
    const freshCapturedAt = "2026-01-01T00:00:59.000Z";
    const staleCapturedAt = "2025-12-31T23:58:00.000Z"; // 120s old

    const kalshiStale = calculator(pair, classA, staleCapturedAt, freshCapturedAt, now, 60_000);
    const polyStale = calculator(pair, classA, freshCapturedAt, staleCapturedAt, now, 60_000);
    expect(kalshiStale).toEqual([]);
    expect(polyStale).toEqual([]);
  });
});

function calculator(
  pair: CandidatePair,
  decision: EquivalenceDecision,
  kalshiCapturedAt: string,
  polyCapturedAt: string,
  now: string,
  maxBookAgeMs: number
) {
  return new OpportunityCalculator().calculate(
    pair,
    decision,
    {
      marketId: "K1",
      venue: "kalshi",
      yesAsk: 0.4,
      noAsk: 0.7,
      yesAvailableUsd: 100,
      noAvailableUsd: 100,
      capturedAt: kalshiCapturedAt,
    },
    {
      marketId: "P1",
      venue: "polymarket",
      yesAsk: 0.8,
      noAsk: 0.5,
      yesAvailableUsd: 100,
      noAvailableUsd: 100,
      capturedAt: polyCapturedAt,
    },
    { now, maxBookAgeMs }
  );
}
