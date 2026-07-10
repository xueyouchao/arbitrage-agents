import { describe, expect, it } from "vitest";
import { OpportunityCalculator } from "../src/contexts/arbitrage/domain/opportunity-calculator";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";

const baseKalshiMarket: NormalizedMarket = {
	id: "k-1",
	venue: "kalshi",
	venueMarketId: "K1",
	title: "BTC above 100k",
	rawResolutionText: "CF Benchmarks",
	topic: "crypto",
	eventType: "price_above",
	asset: "BTC",
	threshold: 100000,
	operator: ">",
	deadline: "2026-07-15T14:00:00.000Z",
	resolutionSource: "CF Benchmarks",
	payoffType: "at_time",
	ambiguityFlags: [],
	confidence: 0.95
};

const basePolymarketMarket: NormalizedMarket = {
	...baseKalshiMarket,
	id: "p-1",
	venue: "polymarket",
	venueMarketId: "P1",
	rawResolutionText: "Binance",
	deadline: "2026-07-15T16:00:00.000Z",
	resolutionSource: "Binance"
};

const classA: EquivalenceDecision = { pairId: "k-1:p-1", equivalenceClass: "A", decision: "tradable", reasons: [] };

const kalshiBook = {
	marketId: "K1",
	venue: "kalshi" as const,
	yesAsk: 0.42,
	noAsk: 0.62,
	yesAvailableUsd: 20,
	noAvailableUsd: 30,
	capturedAt: "2026-07-15T13:00:00.000Z"
};

const polymarketBook = {
	marketId: "P1",
	venue: "polymarket" as const,
	yesAsk: 0.5,
	noAsk: 0.51,
	yesAvailableUsd: 50,
	noAvailableUsd: 12,
	capturedAt: "2026-07-15T13:00:00.000Z"
};

const options = { feeRate: 0.01, slippageRate: 0.005, now: "2026-07-15T13:00:00.000Z" };

describe("OpportunityCalculator risk structure", () => {
	it("stamps a sequential-settlement risk structure on each opportunity", () => {
		const pair: CandidatePair = {
			id: "k-1:p-1",
			kalshiMarket: baseKalshiMarket,
			polymarketMarket: basePolymarketMarket,
			reasons: []
		};

		const opportunities = new OpportunityCalculator().calculate(pair, classA, kalshiBook, polymarketBook, options);

		expect(opportunities).toHaveLength(1);
		const [opportunity] = opportunities;
		expect(opportunity.riskStructure).toBeDefined();
		expect(opportunity.riskStructure!.dtHours).toBe(2);
		expect(opportunity.riskStructure!.exitPolicy).toBe("evaluate");
		expect(opportunity.riskStructure!.basisRiskClass).toBe("diff_ref");
		expect(opportunity.riskStructure!.earlyLeg).toMatchObject({
			venue: "kalshi",
			marketId: "K1",
			side: opportunity.longLeg.side,
			deadline: "2026-07-15T14:00:00.000Z"
		});
		expect(opportunity.riskStructure!.survivingLeg).toMatchObject({
			venue: "polymarket",
			marketId: "P1",
			side: opportunity.hedgeLeg.side,
			deadline: "2026-07-15T16:00:00.000Z"
		});
		expect(opportunity.riskStructure!.payoffType).toBe("at_time");
	});

	it("stamps a simultaneous-settlement risk structure when deadlines match", () => {
		const pair: CandidatePair = {
			id: "k-1:p-1",
			kalshiMarket: { ...baseKalshiMarket, deadline: "2026-07-15T13:30:00.000Z" },
			polymarketMarket: { ...basePolymarketMarket, deadline: "2026-07-15T13:30:00.000Z", resolutionSource: "CF Benchmarks" },
			reasons: []
		};

		const opportunities = new OpportunityCalculator().calculate(pair, classA, kalshiBook, polymarketBook, options);

		expect(opportunities).toHaveLength(1);
		expect(opportunities[0].riskStructure).toMatchObject({
			dtHours: 0,
			exitPolicy: "hold",
			basisRiskClass: "same_ref",
			payoffType: "at_time"
		});
	});
});
