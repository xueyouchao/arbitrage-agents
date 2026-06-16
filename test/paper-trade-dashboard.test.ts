import { describe, expect, it } from "vitest";
import { PaperTradeDashboard, PaperTradeComparisonRow } from "../runbook/paper-trade-dashboard";
import { PaperTradeSimulation } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { NotionalEdge } from "../src/contexts/arbitrage/domain/opportunity";
import { OpportunityReadModel } from "../src/contexts/api/read-models";

const makeNotionalEdge = (targetNotionalUsd: number, netEdge: number, fillable = true): NotionalEdge => ({
  targetNotionalUsd,
  grossEdge: netEdge + 0.01,
  estimatedFees: 0.005,
  estimatedSlippage: 0.005,
  netEdge,
  fillable
});

const makeOpportunity = (overrides: Partial<OpportunityReadModel> = {}): OpportunityReadModel => ({
  id: "00000000-0000-4000-8000-000000000401",
  pairId: "pair-1",
  longLeg: { venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 100, depthLevels: [{ price: 0.4, size: 250 }] },
  hedgeLeg: { venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.5, availableUsd: 80, depthLevels: [{ price: 0.5, size: 160 }] },
  combinedCost: 0.9,
  grossEdge: 0.1,
  estimatedFees: 0,
  estimatedSlippage: 0,
  netEdge: 0.1,
  theoreticalCombinedCost: 0.9,
  theoreticalGrossEdge: 0.1,
  theoreticalNetEdge: 0.1,
  executableSizeUsd: 25,
  executableCombinedCost: 0.9,
  executableGrossEdge: 0.1,
  executableNetEdge: 0.1,
  maxTradableUsd: 50,
  notionalEdges: [
    makeNotionalEdge(5, 0.095),
    makeNotionalEdge(25, 0.085),
    makeNotionalEdge(100, 0.06)
  ],
  equivalenceClass: "A",
  resolutionRisk: "low",
  fillRisk: "low",
  liquidityRisk: "low",
  venueRisk: "low",
  equivalenceRisk: "low",
  dataStalenessMs: 0,
  opportunityAgeMs: 0,
  detectedAt: "2026-06-16T00:00:00.000Z",
  firstDetectedAt: "2026-06-16T00:00:00.000Z",
  lastVerifiedAt: "2026-06-16T00:00:00.000Z",
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1",
  ...overrides
});

const makeSimulation = (targetNotionalUsd: number, netEdge: number, partialFill = false): PaperTradeSimulation => ({
  id: `sim-${targetNotionalUsd}`,
  opportunityId: "00000000-0000-4000-8000-000000000401",
  simulatedAt: "2026-06-16T00:00:00.000Z",
  targetNotionalUsd,
  longLegFill: { averagePrice: 0.4, contracts: targetNotionalUsd / 0.4, fees: 0, slippage: 0 },
  hedgeLegFill: { averagePrice: 0.5, contracts: targetNotionalUsd / 0.5, fees: 0, slippage: 0 },
  adverseSelectionBps: 25,
  partialFill,
  residualExposureUsd: partialFill ? 10 : 0,
  combinedCost: 0.9,
  grossEdge: netEdge + 0.01,
  netEdge,
  configVersion: "phase3-conservative-v1",
  calculationVersion: "opportunity-calculator-v2"
});

describe("PaperTradeDashboard", () => {
  it("returns an empty comparison when no simulations or opportunity edges exist", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity({ notionalEdges: [] });
    const result = dashboard.compare(opportunity, []);
    expect(result.rows).toEqual([]);
    expect(result.summary).toBeUndefined();
  });

  it("matches simulations to notional edges by target notional", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity();
    const simulations = [makeSimulation(5, 0.09), makeSimulation(25, 0.075), makeSimulation(100, 0.04)];
    const result = dashboard.compare(opportunity, simulations);

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.targetNotionalUsd)).toEqual([5, 25, 100]);
    expect(result.rows[0]).toMatchObject({
      apparentEdge: 0.095,
      actionableEdge: 0.09,
      edgeLeakage: 0.005,
      partialFill: false
    });
  });

  it("flags a partial fill when the simulation could not fully execute", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity({ notionalEdges: [makeNotionalEdge(100, 0.06)] });
    const simulations = [makeSimulation(100, 0.04, true)];
    const result = dashboard.compare(opportunity, simulations);

    expect(result.rows[0].partialFill).toBe(true);
    expect(result.rows[0].actionable).toBe(false);
  });

  it("computes expected PnL, fees, slippage, and residual exposure from simulation fills", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity();
    const simulation = makeSimulation(25, 0.075);
    simulation.longLegFill.fees = 0.002;
    simulation.longLegFill.slippage = 0.003;
    simulation.hedgeLegFill.fees = 0.004;
    simulation.hedgeLegFill.slippage = 0.001;

    const result = dashboard.compare(opportunity, [simulation]);
    expect(result.rows[0]).toMatchObject({
      expectedPnlUsd: 1.88,
      totalFees: 0.006,
      totalSlippage: 0.004,
      residualExposureUsd: 0
    });
  });

  it("summarizes the executable notional and best actionable notional", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity({ executableSizeUsd: 25 });
    const simulations = [makeSimulation(5, 0.09), makeSimulation(25, 0.075, true), makeSimulation(100, 0.04, true)];
    const result = dashboard.compare(opportunity, simulations);

    expect(result.summary).toMatchObject({
      executableSizeUsd: 25,
      bestActionableNotionalUsd: 5,
      bestActionableEdge: 0.09,
      worstEdgeLeakageBps: expect.closeTo(200, 1)
    });
  });

  it("sorts rows by target notional ascending", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity({ notionalEdges: [makeNotionalEdge(50, 0.07), makeNotionalEdge(10, 0.09)] });
    const simulations = [makeSimulation(50, 0.065), makeSimulation(10, 0.085)];
    const result = dashboard.compare(opportunity, simulations);
    expect(result.rows.map((r) => r.targetNotionalUsd)).toEqual([10, 50]);
  });

  it("renders a formatted table with header and rows", () => {
    const dashboard = new PaperTradeDashboard();
    const opportunity = makeOpportunity();
    const simulations = [makeSimulation(5, 0.09)];
    const rendered = dashboard.render(opportunity, simulations);
    expect(rendered).toContain("Opportunity");
    expect(rendered).toContain("apparentEdge");
    expect(rendered).toContain("actionableEdge");
    expect(rendered).toContain("5.00");
    expect(rendered).toContain("0.0900");
  });
});

describe("PaperTradeComparisonRow", () => {
  it("calculates edge leakage as apparent minus actionable", () => {
    const row: PaperTradeComparisonRow = {
      targetNotionalUsd: 10,
      apparentEdge: 0.08,
      actionableEdge: 0.06,
      edgeLeakage: 0.02,
      expectedPnlUsd: 0.6,
      totalFees: 0.001,
      totalSlippage: 0.001,
      residualExposureUsd: 0,
      partialFill: false,
      actionable: true,
      opportunityNetEdge: 0.07
    };
    expect(row.edgeLeakage).toBeCloseTo(row.apparentEdge - row.actionableEdge, 4);
  });
});
