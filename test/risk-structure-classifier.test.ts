import { describe, expect, it } from "vitest";
import {
	classifyRiskStructure,
	RiskStructureInput,
} from "../src/contexts/arbitrage/domain/risk-structure-classifier";
import { Venue, PayoffType } from "../src/contexts/matching/domain/normalized-market";
import { ContractSide } from "../src/contexts/arbitrage/domain/opportunity";

function leg(
	venue: Venue,
	marketId: string,
	side: ContractSide,
	deadline?: string,
	resolutionSource?: string,
	payoffType: PayoffType = "settlement_value"
): RiskStructureInput["legA"] {
	return { venue, marketId, side, deadline, resolutionSource, payoffType };
}

describe("classifyRiskStructure", () => {
	it("classifies crypto sequential settlement with different refs as evaluate", () => {
		const result = classifyRiskStructure({
			legA: leg("kalshi", "KXBT", "YES", "2026-07-15T14:00:00.000Z", "CF Benchmarks", "at_time"),
			legB: leg("polymarket", "PBTC", "NO", "2026-07-15T16:00:00.000Z", "Binance", "at_time"),
		});

		expect(result.earlyLeg).toEqual({
			venue: "kalshi",
			marketId: "KXBT",
			side: "YES",
			deadline: "2026-07-15T14:00:00.000Z",
		});
		expect(result.survivingLeg).toEqual({
			venue: "polymarket",
			marketId: "PBTC",
			side: "NO",
			deadline: "2026-07-15T16:00:00.000Z",
		});
		expect(result.dtHours).toBeCloseTo(2, 9);
		expect(result.basisRiskClass).toBe("diff_ref");
		expect(result.payoffType).toBe("at_time");
		expect(result.exitPolicy).toBe("evaluate");
	});

	it("picks the earlier deadline regardless of input order", () => {
		const result = classifyRiskStructure({
			legA: leg("polymarket", "PBTC", "NO", "2026-07-15T16:00:00.000Z", "Binance", "at_time"),
			legB: leg("kalshi", "KXBT", "YES", "2026-07-15T14:00:00.000Z", "CF Benchmarks", "at_time"),
		});

		expect(result.earlyLeg.venue).toBe("kalshi");
		expect(result.earlyLeg.marketId).toBe("KXBT");
		expect(result.survivingLeg.venue).toBe("polymarket");
		expect(result.survivingLeg.marketId).toBe("PBTC");
		expect(result.dtHours).toBeCloseTo(2, 9);
		expect(result.exitPolicy).toBe("evaluate");
	});

	it("classifies macro simultaneous settlement with same ref as hold", () => {
		const result = classifyRiskStructure({
			legA: leg("kalshi", "KFX", "YES", "2026-07-15T13:30:00.000Z", "CME", "settlement_value"),
			legB: leg("polymarket", "PFX", "NO", "2026-07-15T13:30:00.000Z", "CME", "settlement_value"),
		});

		expect(result.dtHours).toBe(0);
		expect(result.basisRiskClass).toBe("same_ref");
		expect(result.exitPolicy).toBe("hold");
		expect(result.earlyLeg.marketId).toBe("KFX");
		expect(result.survivingLeg.marketId).toBe("PFX");
	});

	it("holds simultaneous settlement even when refs differ", () => {
		const result = classifyRiskStructure({
			legA: leg("kalshi", "KFX", "YES", "2026-07-15T13:30:00.000Z", "CME", "settlement_value"),
			legB: leg("polymarket", "PFX", "NO", "2026-07-15T13:30:00.000Z", "Reuters", "settlement_value"),
		});

		expect(result.dtHours).toBe(0);
		expect(result.basisRiskClass).toBe("diff_ref");
		expect(result.exitPolicy).toBe("hold");
	});

	it("treats a missing deadline as simultaneous (hold)", () => {
		const result = classifyRiskStructure({
			legA: leg("kalshi", "KFX", "YES", undefined, "CME", "settlement_value"),
			legB: leg("polymarket", "PFX", "NO", "2026-07-15T13:30:00.000Z", "CME", "settlement_value"),
		});

		expect(result.dtHours).toBe(0);
		expect(result.exitPolicy).toBe("hold");
	});

	it("treats a missing resolution source as diff_ref", () => {
		const result = classifyRiskStructure({
			legA: leg("kalshi", "KFX", "YES", "2026-07-15T14:00:00.000Z", undefined, "settlement_value"),
			legB: leg("polymarket", "PFX", "NO", "2026-07-15T16:00:00.000Z", "CME", "settlement_value"),
		});

		expect(result.dtHours).toBeCloseTo(2, 9);
		expect(result.exitPolicy).toBe("evaluate");
		expect(result.basisRiskClass).toBe("diff_ref");
	});

	it("treats sub-threshold deadline dust as simultaneous but evaluates once the rounded gap reaches 0.001h", () => {
		const belowThreshold = classifyRiskStructure({
			// 1 second = 0.000278h → rounds to 0.000 → hold.
			legA: leg("kalshi", "KFX", "YES", "2026-07-15T14:00:00.000Z", "CME", "settlement_value"),
			legB: leg("polymarket", "PFX", "NO", "2026-07-15T14:00:01.000Z", "CME", "settlement_value"),
		});
		expect(belowThreshold.dtHours).toBe(0);
		expect(belowThreshold.exitPolicy).toBe("hold");

		const atThreshold = classifyRiskStructure({
			// 4 seconds = 0.001111h → rounds to 0.001 → evaluate.
			legA: leg("kalshi", "KFY", "YES", "2026-07-15T14:00:00.000Z", "CME", "settlement_value"),
			legB: leg("polymarket", "PFY", "NO", "2026-07-15T14:00:04.000Z", "CME", "settlement_value"),
		});
		expect(atThreshold.dtHours).toBe(0.001);
		expect(atThreshold.exitPolicy).toBe("evaluate");
	});
});
