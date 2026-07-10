import { describe, it, expect } from "vitest";
import {
  buildT1ExitAlerts,
  evaluateT1ExitAlert,
  T1ExitAlert,
  T1TriggerRegistry,
} from "../src/contexts/arbitrage/domain/t1-exit-advisor";
import { CrossVenueOpportunity, ContractLeg } from "../src/contexts/arbitrage/domain/opportunity";

const makeLeg = (overrides: Partial<ContractLeg> = {}): ContractLeg => ({
  venue: "kalshi",
  marketId: "m1",
  side: "YES",
  askPrice: 0.5,
  availableUsd: 10_000,
  ...overrides,
});

const makeOpportunity = (overrides: Partial<CrossVenueOpportunity> = {}): CrossVenueOpportunity => ({
  id: "opp-1",
  pairId: "pair-1",
  longLeg: makeLeg({ venue: "kalshi", marketId: "kalshi-m1", side: "YES" }),
  hedgeLeg: makeLeg({ venue: "polymarket", marketId: "poly-m1", side: "NO" }),
  combinedCost: 0.95,
  grossEdge: 0.05,
  estimatedFees: 0.01,
  estimatedSlippage: 0.005,
  netEdge: 0.035,
  theoreticalCombinedCost: 0.94,
  theoreticalGrossEdge: 0.06,
  theoreticalNetEdge: 0.045,
  executableSizeUsd: 100,
  executableCombinedCost: 0.95,
  executableGrossEdge: 0.05,
  executableNetEdge: 0.035,
  maxTradableUsd: 1_000,
  notionalEdges: [],
  equivalenceClass: "A",
  resolutionRisk: "low",
  fillRisk: "low",
  liquidityRisk: "low",
  venueRisk: "low",
  equivalenceRisk: "low",
  dataStalenessMs: 0,
  opportunityAgeMs: 0,
  detectedAt: "2026-07-10T12:00:00Z",
  firstDetectedAt: "2026-07-10T12:00:00Z",
  lastVerifiedAt: "2026-07-10T12:00:00Z",
  calculationVersion: "v1",
  configVersion: "v1",
  ...overrides,
});

describe("buildT1ExitAlerts", () => {
  it("emits a t1 alert for a sequential opportunity with exitPolicy evaluate", () => {
    const opp = makeOpportunity({
      riskStructure: {
        earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
        survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "NO", deadline: "2026-07-15T16:00:00Z" },
        dtHours: 2,
        basisRiskClass: "same_ref",
        payoffType: "at_time",
        exitPolicy: "evaluate",
      },
    });
    const alerts = buildT1ExitAlerts([opp]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "NO" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
    });
    expect(alerts[0].gateResult).toBeUndefined();
    expect(alerts[0].recommendedSellPrice).toBeUndefined();
    expect(alerts[0].recommendedSellSize).toBeUndefined();
    expect(alerts[0].reasoning).toBeUndefined();
  });

  it("emits no alert for simultaneous settlement (exitPolicy hold)", () => {
    const opp = makeOpportunity({
      riskStructure: {
        earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
        survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "NO", deadline: "2026-07-15T14:00:00Z" },
        dtHours: 0,
        basisRiskClass: "same_ref",
        payoffType: "at_time",
        exitPolicy: "hold",
      },
    });
    expect(buildT1ExitAlerts([opp])).toEqual([]);
  });

  it("emits no alert when riskStructure is absent", () => {
    expect(buildT1ExitAlerts([makeOpportunity()])).toEqual([]);
  });
});

describe("evaluateT1ExitAlert", () => {
  it("populates gate fields from a surviving-leg book snapshot", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "poly-m1",
        side: "YES",
        bidPrice: 0.98,
        askPrice: 0.99,
        depth: [{ price: 0.98, size: 1000 }],
      },
      100,
    );

    expect(evaluated.gateResult).toBe("pass");
    expect(evaluated.recommendedSellPrice).toBe(0.98);
    expect(evaluated.recommendedSellSize).toBe(100);
    expect(evaluated.lockValue).toBe(0.98 * 100);
    expect(evaluated.exitCost).toBeCloseTo(0.98 * (0.01 + 0.01) + 0.005, 6);
    expect(evaluated.holdExpectedValue).toBeCloseTo(0.985 * (1 - 0.04), 6);
    expect(evaluated.reasoning?.length).toBeGreaterThan(0);
  });

  it("records a fail when there is no liquidity", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "poly-m1",
        side: "YES",
        bidPrice: 0.98,
        askPrice: 0.99,
        depth: [],
      },
      100,
    );

    expect(evaluated.gateResult).toBe("fail");
    expect(evaluated.recommendedSellSize).toBe(0);
    expect(evaluated.reasoning).toContain("liquidity");
  });

  it("fails when the book bid price is NaN (invalid-input guard)", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "poly-m1",
        side: "YES",
        bidPrice: NaN,
        askPrice: 0.99,
        depth: [{ price: 0.98, size: 1000 }],
      },
      100,
    );

    expect(evaluated.gateResult).toBe("fail");
    expect(evaluated.recommendedSellSize).toBe(0);
    expect(evaluated.reasoning).toContain("invalid");
  });

  it("fails when depth levels carry negative sizes (invalid-input guard)", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "poly-m1",
        side: "YES",
        bidPrice: 0.98,
        askPrice: 0.99,
        // cumulative depth ignores non-positive sizes → availableDepth 0 → fail
        depth: [
          { price: 0.98, size: -500 },
          { price: 0.97, size: 0 },
        ],
      },
      100,
    );

    expect(evaluated.gateResult).toBe("fail");
    expect(evaluated.recommendedSellSize).toBe(0);
  });

  it("fails when the book marketId does not match the surviving leg", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "wrong-market",
        side: "YES",
        bidPrice: 0.98,
        askPrice: 0.99,
        depth: [{ price: 0.98, size: 1000 }],
      },
      100,
    );

    expect(evaluated.gateResult).toBe("fail");
    expect(evaluated.reasoning).toContain("marketId mismatch");
  });

  it("fails the exit-cost gate when fees blow out the edge", () => {
    const alert: T1ExitAlert = {
      opportunityId: "opp-1",
      pairId: "pair-1",
      triggerAt: "2026-07-15T14:00:00Z",
      earlyLeg: { venue: "kalshi", marketId: "kalshi-m1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
      survivingLeg: { venue: "polymarket", marketId: "poly-m1", side: "YES" },
      exitPolicy: "evaluate",
      basisRiskClass: "same_ref",
      dtHours: 2,
      payoffType: "at_time",
    };

    // sellFeeRate 0.5 makes exitCost huge → lockPerShare − holdEV < exitCost + minMargin.
    const evaluated = evaluateT1ExitAlert(
      alert,
      {
        marketId: "poly-m1",
        side: "YES",
        bidPrice: 0.98,
        askPrice: 0.99,
        depth: [{ price: 0.98, size: 1000 }],
      },
      100,
      { sellFeeRate: 0.5 },
    );

    expect(evaluated.gateResult).toBe("fail");
    // The failure is the exit-cost gate (liquidity is fine: depth 1000 > 0).
    expect(evaluated.reasoning).toContain("exit-cost gate");
    expect(evaluated.reasoning).toContain("FAIL");
  });
});

describe("T1TriggerRegistry", () => {
  it("tracks pending and evaluated alerts", () => {
    const evaluateOpp = makeOpportunity({
      id: "opp-eval",
      pairId: "pair-eval",
      riskStructure: {
        earlyLeg: { venue: "kalshi", marketId: "k1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
        survivingLeg: { venue: "polymarket", marketId: "p1", side: "NO", deadline: "2026-07-15T16:00:00Z" },
        dtHours: 2,
        basisRiskClass: "same_ref",
        payoffType: "at_time",
        exitPolicy: "evaluate",
      },
    });
    const holdOpp = makeOpportunity({
      id: "opp-hold",
      pairId: "pair-hold",
      riskStructure: {
        earlyLeg: { venue: "kalshi", marketId: "k2", side: "YES", deadline: "2026-07-15T14:00:00Z" },
        survivingLeg: { venue: "polymarket", marketId: "p2", side: "NO", deadline: "2026-07-15T14:00:00Z" },
        dtHours: 0,
        basisRiskClass: "same_ref",
        payoffType: "at_time",
        exitPolicy: "hold",
      },
    });

    const registry = new T1TriggerRegistry();
    registry.registerOpportunity(evaluateOpp);
    registry.registerOpportunity(holdOpp);

    expect(registry.pending()).toHaveLength(1);
    expect(registry.pending()[0].opportunityId).toBe("opp-eval");
    expect(registry.evaluated()).toHaveLength(0);

    const pending = registry.pending()[0];
    const evaluated = evaluateT1ExitAlert(
      pending,
      {
        marketId: "p1",
        side: "NO",
        bidPrice: 0.98,
        askPrice: 0.99,
        depth: [{ price: 0.98, size: 1000 }],
      },
      100,
    );

    registry.registerAlert(evaluated);

    expect(registry.pending()).toHaveLength(0);
    expect(registry.evaluated()).toHaveLength(1);
    expect(registry.evaluated()[0].gateResult).toBe("pass");
  });

  it("clears all tracked alerts", () => {
    const registry = new T1TriggerRegistry();
    registry.registerOpportunity(
      makeOpportunity({
        id: "opp-clear",
        riskStructure: {
          earlyLeg: { venue: "kalshi", marketId: "k1", side: "YES", deadline: "2026-07-15T14:00:00Z" },
          survivingLeg: { venue: "polymarket", marketId: "p1", side: "NO" },
          dtHours: 2,
          basisRiskClass: "same_ref",
          payoffType: "at_time",
          exitPolicy: "evaluate",
        },
      }),
    );
    registry.clear();
    expect(registry.pending()).toHaveLength(0);
    expect(registry.evaluated()).toHaveLength(0);
  });
});
