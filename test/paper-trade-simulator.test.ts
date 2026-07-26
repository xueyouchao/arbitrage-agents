import { describe, expect, it } from "vitest";
import { PaperTradeSimulator } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { ContractLeg, CrossVenueOpportunity, FeeModel, RiskLevel } from "../src/contexts/arbitrage/domain/opportunity";

const leg = (overrides: Partial<ContractLeg>): ContractLeg => ({
  venue: "kalshi",
  marketId: "K1",
  side: "YES",
  askPrice: 0.4,
  availableUsd: 50,
  feeRate: 0,
  slippageRate: 0,
  depthLevels: [{ price: 0.4, size: 100 }],
  ...overrides
});

const baseOpportunity = (overrides: Partial<CrossVenueOpportunity> = {}): CrossVenueOpportunity => ({
  id: "k-1:p-1:kalshi_yes-polymarket_no",
  pairId: "k-1:p-1",
  longLeg: leg({ venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 50, depthLevels: [{ price: 0.4, size: 125 }] }),
  hedgeLeg: leg({ venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.5, availableUsd: 30, depthLevels: [{ price: 0.5, size: 60 }] }),
  combinedCost: 0.9,
  grossEdge: 0.1,
  estimatedFees: 0,
  estimatedSlippage: 0,
  netEdge: 0.1,
  theoreticalCombinedCost: 0.9,
  theoreticalGrossEdge: 0.1,
  theoreticalNetEdge: 0.1,
  executableSizeUsd: 30,
  executableCombinedCost: 0.9,
  executableGrossEdge: 0.1,
  executableNetEdge: 0.1,
  maxTradableUsd: 30,
  notionalEdges: [],
  equivalenceClass: "A",
  resolutionRisk: "low" as RiskLevel,
  fillRisk: "low" as RiskLevel,
  liquidityRisk: "low" as RiskLevel,
  venueRisk: "low" as RiskLevel,
  equivalenceRisk: "low" as RiskLevel,
  dataStalenessMs: 0,
  opportunityAgeMs: 0,
  detectedAt: "2026-06-16T00:00:00.000Z",
  firstDetectedAt: "2026-06-16T00:00:00.000Z",
  lastVerifiedAt: "2026-06-16T00:00:00.000Z",
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1",
  ...overrides
});

const kalshiFlatFee: FeeModel = { type: "flat", rate: 0.01, version: "test-flat" };

describe("PaperTradeSimulator", () => {
  it("simulates a full fill on both legs at a single target notional with zero fees and slippage", () => {
    const simulator = new PaperTradeSimulator();
    const sims = simulator.simulate(baseOpportunity(), { adverseSelectionBps: 0 });

    const sim25 = sims.find((s) => s.targetNotionalUsd === 25)!;
    expect(sim25).toBeDefined();
    expect(sim25).toMatchObject({
      partialFill: false,
      longLegFill: { averagePrice: 0.4 },
      hedgeLegFill: { averagePrice: 0.5 },
      combinedCost: 0.9,
      grossEdge: 0.1,
      netEdge: 0.1,
      residualExposureUsd: 0
    });
    expect(sim25.configVersion).toBe("phase3-conservative-v1");
    expect(sim25.calculationVersion).toBe("opportunity-calculator-v2");
  });

  it("marks a partial fill when target notional exceeds available depth on the long leg", () => {
    const opportunity = baseOpportunity({
      longLeg: leg({ venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 50, depthLevels: [{ price: 0.4, size: 50 }] }),
      hedgeLeg: leg({ venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.5, availableUsd: 30, depthLevels: [{ price: 0.5, size: 30 }] }),
      maxTradableUsd: 30,
      executableSizeUsd: 30
    });
    const sims = new PaperTradeSimulator().simulate(opportunity, { targetNotionalsUsd: [100], adverseSelectionBps: 0 });

    expect(sims).toHaveLength(1);
    const sim = sims[0];
    expect(sim.longLegFill.averagePrice).toBeCloseTo(0.4, 4);
    expect(sim.hedgeLegFill.averagePrice).toBeCloseTo(0.5, 4);
    expect(sim.partialFill).toBe(true);
    expect(sim.residualExposureUsd).toBeGreaterThan(0);
  });

  it("applies the configured adverse-selection bps shift to the hedge leg's effective price", () => {
    const opportunity = baseOpportunity();
    const sims = new PaperTradeSimulator().simulate(opportunity, {
      targetNotionalsUsd: [25],
      adverseSelectionBps: 50
    });
    const sim = sims[0];
    expect(sim.hedgeLegFill.averagePrice).toBeCloseTo(0.5025, 4);
    expect(sim.longLegFill.averagePrice).toBeCloseTo(0.4, 4);
    expect(sim.adverseSelectionBps).toBe(50);
  });

  it("falls back to top-of-book ask + availableUsd when depth levels are missing", () => {
    const opportunity = baseOpportunity({
      longLeg: leg({ venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 50, depthLevels: undefined }),
      hedgeLeg: leg({ venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.5, availableUsd: 30, depthLevels: undefined })
    });
    const sims = new PaperTradeSimulator().simulate(opportunity, { targetNotionalsUsd: [10], adverseSelectionBps: 0 });

    expect(sims).toHaveLength(1);
    expect(sims[0].longLegFill.averagePrice).toBeCloseTo(0.4, 4);
    expect(sims[0].hedgeLegFill.averagePrice).toBeCloseTo(0.5, 4);
    expect(sims[0].partialFill).toBe(false);
  });

  it("applies probability-weighted Polymarket fees from the opportunity leg's fee model", () => {
    const opportunity = baseOpportunity({
      hedgeLeg: leg({
        venue: "polymarket",
        marketId: "P1",
        side: "NO",
        askPrice: 0.5,
        availableUsd: 30,
        depthLevels: [{ price: 0.5, size: 60 }],
        feeModel: { type: "polymarket", probabilityWeighted: true, probabilityWeightedRate: 0.09, orderRole: "taker", version: "test-poly-crypto" }
      })
    });

    const [sim] = new PaperTradeSimulator().simulate(opportunity, { targetNotionalsUsd: [25], adverseSelectionBps: 0 });

    // Representative formula: fee = coefficient * price * (1 - price).
    // coefficient 0.09, price 0.5 -> 0.09 * 0.5 * 0.5 = 0.0225.
    expect(sim.hedgeLegFill.averagePrice).toBeCloseTo(0.5, 4);
    expect(sim.hedgeLegFill.fees).toBeCloseTo(0.0225, 4);
  });

  it("uses flat fee model from the configured fee model registry", () => {
    const opportunity = baseOpportunity();
    const sims = new PaperTradeSimulator().simulate(opportunity, {
      targetNotionalsUsd: [25],
      adverseSelectionBps: 0,
      feeModels: { kalshi: kalshiFlatFee, polymarket: { type: "flat", rate: 0 } }
    });
    const sim = sims[0];
    expect(sim.longLegFill.fees).toBeCloseTo(0.004, 4);
    expect(sim.hedgeLegFill.fees).toBeCloseTo(0, 4);
  });

  it("stamps calculation and config versions from the opportunity on every simulation record", () => {
    const opportunity = baseOpportunity({ calculationVersion: "test-calc-v3", configVersion: "test-cfg-v7" });
    const sims = new PaperTradeSimulator().simulate(opportunity, { targetNotionalsUsd: [5] });
    expect(sims[0]).toMatchObject({ calculationVersion: "test-calc-v3", configVersion: "test-cfg-v7" });
  });

  it("uses opportunity.executableSizeUsd as a default target when no targetNotionalsUsd is provided", () => {
    const opportunity = baseOpportunity({ executableSizeUsd: 12 });
    const sims = new PaperTradeSimulator().simulate(opportunity);
    const executableTarget = sims.find((s) => s.targetNotionalUsd === 12);
    expect(executableTarget).toBeDefined();
  });
});
