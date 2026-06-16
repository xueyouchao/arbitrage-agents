import { describe, expect, it } from "vitest";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { CompletedScanArtifacts, OpportunityWithSourceSnapshots } from "../src/contexts/scanner/scanner-repository";
import { CrossVenueOpportunity, ContractLeg, RiskLevel } from "../src/contexts/arbitrage/domain/opportunity";
import { PaperTradeSimulation, PaperTradeSimulator } from "../src/contexts/arbitrage/domain/paper-trade-simulator";

const leg = (overrides: Partial<ContractLeg>): ContractLeg => ({
  venue: "kalshi",
  marketId: "K1",
  side: "YES",
  askPrice: 0.4,
  availableUsd: 50,
  feeRate: 0,
  slippageRate: 0,
  depthLevels: [{ price: 0.4, size: 125 }],
  ...overrides
});

const opportunity = (overrides: Partial<CrossVenueOpportunity> = {}): CrossVenueOpportunity => ({
  id: "k-1:p-1:kalshi_yes-polymarket_no",
  pairId: "k-1:p-1",
  longLeg: leg({ venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 50 }),
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

const artifacts = (paperTradeSimulations: PaperTradeSimulation[]): CompletedScanArtifacts => {
  const opp: OpportunityWithSourceSnapshots = {
    opportunity: opportunity(),
    kalshiOrderbookSnapshotId: "snap-k",
    polymarketOrderbookSnapshotId: "snap-p"
  };
  return {
    scanRun: { id: "scan-1", status: "succeeded", startedAt: "2026-06-16T00:00:00.000Z", metrics: { marketsScanned: 2, normalizedMarkets: 2, candidatePairs: 1, opportunitiesFound: 1, llmEvaluations: 0 } },
    completeScanRun: (scanRun) => ({ ...scanRun, completedAt: "2026-06-16T00:00:01.000Z" }),
    snapshots: [],
    normalizedMarkets: [],
    candidatePairs: [],
    orderbookSnapshots: [],
    opportunities: [opp],
    paperTradeSimulations
  };
};

describe("Scanner artifacts: paper-trade simulations", () => {
  it("the in-memory repository records paperTradeSimulations passed in via CompletedScanArtifacts", async () => {
    const repository = new InMemoryScannerRepository();
    const simulator = new PaperTradeSimulator();
    const opp = opportunity();
    const sims = simulator.simulate(opp, { adverseSelectionBps: 0 });

    await repository.saveCompletedScan(artifacts(sims));

    expect(repository.paperTradeSimulations).toHaveLength(sims.length);
    expect(repository.paperTradeSimulations[0].opportunityId).toBe(opp.id);
    expect(repository.paperTradeSimulations[0].targetNotionalUsd).toBe(5);
  });

  it("PaperTradeSimulator emits one simulation per target notional, all sharing the parent opportunity id", () => {
    const simulator = new PaperTradeSimulator();
    const opp = opportunity();
    const sims = simulator.simulate(opp, { targetNotionalsUsd: [5, 25, 100], adverseSelectionBps: 0 });
    expect(sims).toHaveLength(3);
    expect(new Set(sims.map((s) => s.opportunityId))).toEqual(new Set([opp.id]));
  });

  it("a malformed opportunity degrades to a partial-fill record instead of throwing", () => {
    const simulator = new PaperTradeSimulator();
    const malformed: CrossVenueOpportunity = opportunity({
      longLeg: leg({ venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0, availableUsd: 0, depthLevels: [] }),
      hedgeLeg: leg({ venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0, availableUsd: 0, depthLevels: [] })
    });
    const sims = simulator.simulate(malformed, { targetNotionalsUsd: [5], adverseSelectionBps: 0 });
    expect(sims).toHaveLength(1);
    expect(sims[0].partialFill).toBe(true);
  });
});
