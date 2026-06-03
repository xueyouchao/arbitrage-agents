import { describe, expect, it } from "vitest";
import { OpportunityCalculator } from "../src/contexts/arbitrage/domain/opportunity-calculator";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";

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
      estimatedFees: 0.0093,
      estimatedSlippage: 0.0047,
      netEdge: 0.056,
      maxTradableUsd: 12,
      fillRisk: "medium"
    });
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
});
