import { describe, expect, it } from "vitest";
import {
	ContractSide,
	CrossVenueOpportunity,
	RiskStructure,
	BasisRiskClass,
	ExitPolicy,
	GateResult,
} from "../src/contexts/arbitrage/domain/opportunity";
import { Venue, PayoffType } from "../src/contexts/matching/domain/normalized-market";

function makeMinimalOpportunity(): CrossVenueOpportunity {
	const leg = {
		venue: "kalshi" as Venue,
		marketId: "K1",
		side: "YES" as ContractSide,
		askPrice: 0.42,
		availableUsd: 20,
	};

	return {
		id: "test-opp-1",
		pairId: "k-1:p-1",
		longLeg: leg,
		hedgeLeg: { ...leg, side: "NO" as ContractSide },
		combinedCost: 0.93,
		grossEdge: 0.07,
		estimatedFees: 0.0093,
		estimatedSlippage: 0.0046,
		netEdge: 0.0561,
		theoreticalCombinedCost: 0.93,
		theoreticalGrossEdge: 0.07,
		theoreticalNetEdge: 0.0561,
		executableSizeUsd: 12,
		executableCombinedCost: 0.93,
		executableGrossEdge: 0.07,
		executableNetEdge: 0.0561,
		maxTradableUsd: 12,
		notionalEdges: [
			{
				targetNotionalUsd: 5,
				grossEdge: 0.07,
				estimatedFees: 0.0093,
				estimatedSlippage: 0.0046,
				netEdge: 0.0561,
				fillable: true,
			},
		],
		equivalenceClass: "A",
		resolutionRisk: "low",
		fillRisk: "medium",
		liquidityRisk: "medium",
		venueRisk: "low",
		equivalenceRisk: "low",
		dataStalenessMs: 0,
		opportunityAgeMs: 0,
		detectedAt: "2026-01-01T00:00:00.000Z",
		firstDetectedAt: "2026-01-01T00:00:00.000Z",
		lastVerifiedAt: "2026-01-01T00:00:00.000Z",
		calculationVersion: "test",
		configVersion: "test",
	};
}

describe("RiskStructure domain types", () => {
	it("supports a minimal CrossVenueOpportunity without riskStructure", () => {
		const opp = makeMinimalOpportunity();

		expect(opp.riskStructure).toBeUndefined();
	});

	it("round-trips a RiskStructure classification block", () => {
		const opp = makeMinimalOpportunity();

		const basisRiskClass: BasisRiskClass = "same_ref";
		const exitPolicy: ExitPolicy = "evaluate";

		const riskStructure: RiskStructure = {
			earlyLeg: {
				venue: "kalshi" as Venue,
				marketId: "K1",
				side: "YES" as ContractSide,
				deadline: "2026-01-01T00:00:00.000Z",
			},
			survivingLeg: {
				venue: "polymarket" as Venue,
				marketId: "P1",
				side: "NO" as ContractSide,
				deadline: "2026-01-02T00:00:00.000Z",
			},
			dtHours: 24,
			basisRiskClass,
			payoffType: "at_time" as PayoffType,
			exitPolicy,
			// gateResult intentionally omitted — it is `undefined` until t1 runs.
		};

		opp.riskStructure = riskStructure;

		expect(opp.riskStructure.earlyLeg).toEqual({
			venue: "kalshi",
			marketId: "K1",
			side: "YES",
			deadline: "2026-01-01T00:00:00.000Z",
		});
		expect(opp.riskStructure.survivingLeg).toEqual({
			venue: "polymarket",
			marketId: "P1",
			side: "NO",
			deadline: "2026-01-02T00:00:00.000Z",
		});
		expect(opp.riskStructure.dtHours).toBe(24);
		expect(opp.riskStructure.basisRiskClass).toBe("same_ref");
		expect(opp.riskStructure.payoffType).toBe("at_time");
		expect(opp.riskStructure.exitPolicy).toBe("evaluate");
		expect(opp.riskStructure.gateResult).toBeUndefined();
	});

	it("keeps t1-evaluated fields optional when not provided", () => {
		const riskStructure: RiskStructure = {
			earlyLeg: {
				venue: "kalshi" as Venue,
				marketId: "K1",
				side: "YES" as ContractSide,
			},
			survivingLeg: {
				venue: "polymarket" as Venue,
				marketId: "P1",
				side: "NO" as ContractSide,
			},
			dtHours: 0,
			basisRiskClass: "diff_ref",
			payoffType: "settlement_value" as PayoffType,
			exitPolicy: "hold",
		};

		expect(riskStructure.lockValue).toBeUndefined();
		expect(riskStructure.holdExpectedValue).toBeUndefined();
		expect(riskStructure.exitCost).toBeUndefined();
		expect(riskStructure.recommendedSellPrice).toBeUndefined();
		expect(riskStructure.recommendedSellSize).toBeUndefined();
		expect(riskStructure.reasoning).toBeUndefined();
	});
});
