import { describe, expect, it } from "vitest";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { CompletedScanArtifacts, CompletedScanResult } from "../src/contexts/scanner/scanner-repository";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import { PaperTradeSimulation } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";

const startedAt = "2026-06-03T11:59:59.000Z";
const capturedAt = "2026-06-03T12:00:00.000Z";
const completedAt = "2026-06-03T12:00:01.000Z";

const kalshiMarket: NormalizedMarket = {
  id: "kalshi:K1",
  venue: "kalshi",
  venueMarketId: "K1",
  title: "BTC above 100k",
  rawResolutionText: "Coinbase BTC/USD",
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
const polymarketMarket: NormalizedMarket = { ...kalshiMarket, id: "polymarket:P1", venue: "polymarket", venueMarketId: "P1" };
const pair: CandidatePair = { id: "kalshi:K1:polymarket:P1", kalshiMarket, polymarketMarket, reasons: ["deterministic_fields_match"] };
const decision: EquivalenceDecision = { pairId: pair.id, equivalenceClass: "A", decision: "tradable", reasons: [] };

const opportunity: CrossVenueOpportunity = {
  id: "opp-1",
  pairId: pair.id,
  longLeg: { venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.42, availableUsd: 20, feeRate: 0.01, slippageRate: 0.005 },
  hedgeLeg: { venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.51, availableUsd: 12, feeRate: 0.01, slippageRate: 0.005 },
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
    { targetNotionalUsd: 5, grossEdge: 0.07, estimatedFees: 0.0093, estimatedSlippage: 0.0046, netEdge: 0.0561, fillable: true }
  ],
  equivalenceClass: "A",
  resolutionRisk: "low",
  fillRisk: "medium",
  liquidityRisk: "medium",
  venueRisk: "low",
  equivalenceRisk: "low",
  dataStalenessMs: 500,
  opportunityAgeMs: 0,
  detectedAt: capturedAt,
  firstDetectedAt: capturedAt,
  lastVerifiedAt: capturedAt,
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1"
};

const kalshiSnapshotId = "scan-1:kalshi:K1:2026-06-03T12:00:00.000Z";
const polymarketSnapshotId = "scan-1:polymarket:P1:2026-06-03T12:00:00.000Z";

const snapshot: VenueMarketSnapshot = {
  venue: "kalshi",
  venueMarketId: "K1",
  title: kalshiMarket.title,
  rawResolutionText: kalshiMarket.rawResolutionText,
  rawPayload: { source: "kalshi" },
  capturedAt
};

const paperTradeSimulation: PaperTradeSimulation = {
  id: "sim-1",
  opportunityId: opportunity.id,
  simulatedAt: capturedAt,
  targetNotionalUsd: 5,
  longLegFill: { averagePrice: 0.42, contracts: 11.9, fees: 0.05, slippage: 0.002 },
  hedgeLegFill: { averagePrice: 0.51, contracts: 9.8, fees: 0.05, slippage: 0.002 },
  adverseSelectionBps: 10,
  partialFill: false,
  residualExposureUsd: 0,
  combinedCost: 0.93,
  grossEdge: 0.07,
  netEdge: 0.0561,
  configVersion: "phase3-conservative-v1",
  calculationVersion: "opportunity-calculator-v2"
};

function artifacts(scanRunId: string): CompletedScanArtifacts {
  return {
    scanRun: {
      id: scanRunId,
      status: "succeeded",
      startedAt,
      metrics: { marketsScanned: 2, normalizedMarkets: 2, candidatePairs: 1, opportunitiesFound: 1, llmEvaluations: 0 }
    },
    completeScanRun: (scanRun) => ({ ...scanRun, completedAt }),
    snapshots: [
      { ...snapshot },
      { ...snapshot, venue: "polymarket", venueMarketId: "P1", title: polymarketMarket.title, rawResolutionText: polymarketMarket.rawResolutionText, rawPayload: { source: "polymarket" } }
    ],
    normalizedMarkets: [{ market: kalshiMarket }, { market: polymarketMarket }],
    candidatePairs: [{ pair, decision }],
    orderbookSnapshots: [
      {
        id: kalshiSnapshotId,
        scanRunId,
        normalizedMarketId: kalshiMarket.id,
        venue: "kalshi",
        venueMarketId: "K1",
        yesAsk: 0.42,
        noAsk: 0.62,
        yesAvailableUsd: 20,
        noAvailableUsd: 30,
        rawPayload: { source: "kalshi" },
        capturedAt,
        stale: false
      },
      {
        id: polymarketSnapshotId,
        scanRunId,
        normalizedMarketId: polymarketMarket.id,
        venue: "polymarket",
        venueMarketId: "P1",
        yesAsk: 0.5,
        noAsk: 0.51,
        yesAvailableUsd: 50,
        noAvailableUsd: 12,
        rawPayload: { source: "polymarket" },
        capturedAt,
        stale: false
      }
    ],
    opportunities: [{ opportunity, kalshiOrderbookSnapshotId: kalshiSnapshotId, polymarketOrderbookSnapshotId: polymarketSnapshotId }],
    paperTradeSimulations: [paperTradeSimulation]
  };
}

describe("InMemoryScannerRepository resume idempotency", () => {
  it("replaces all per-scan artifacts when saveCompletedScan is called twice with the same scanRunId", async () => {
    const repository = new InMemoryScannerRepository();

    await repository.saveCompletedScan(artifacts("scan-1"));

    // Sanity: first save populates every collection.
    expect(repository.snapshots).toHaveLength(2);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.orderbookSnapshots).toHaveLength(2);
    expect(repository.opportunities).toHaveLength(1);
    expect(repository.paperTradeSimulations).toHaveLength(1);
    expect(repository.scanRuns).toHaveLength(1);

    // Simulate a resume: saveCompletedScan is invoked again with the
    // same scanRunId. Every collection should be replaced, not appended.
    await repository.saveCompletedScan(artifacts("scan-1"));

    expect(repository.snapshots).toHaveLength(2);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.orderbookSnapshots).toHaveLength(2);
    expect(repository.opportunities).toHaveLength(1);
    expect(repository.paperTradeSimulations).toHaveLength(1);
    // scanRuns must also replace, not append.
    expect(repository.scanRuns).toHaveLength(1);
    expect(repository.scanRuns[0]).toMatchObject({ id: "scan-1", status: "succeeded", completedAt });
  });

  it("preserves artifacts from other scan runs when replacing a resumed run", async () => {
    const repository = new InMemoryScannerRepository();

    await repository.saveCompletedScan(artifacts("scan-1"));
    await repository.saveCompletedScan(artifacts("scan-2"));

    // Two distinct scan runs → double the artifacts.
    expect(repository.snapshots).toHaveLength(4);
    expect(repository.normalizedMarkets).toHaveLength(4);
    expect(repository.candidatePairs).toHaveLength(2);
    expect(repository.orderbookSnapshots).toHaveLength(4);
    expect(repository.opportunities).toHaveLength(2);
    expect(repository.paperTradeSimulations).toHaveLength(2);
    expect(repository.scanRuns).toHaveLength(2);

    // Resume scan-1: its artifacts are replaced, scan-2 is untouched.
    await repository.saveCompletedScan(artifacts("scan-1"));

    expect(repository.snapshots).toHaveLength(4);
    expect(repository.normalizedMarkets).toHaveLength(4);
    expect(repository.candidatePairs).toHaveLength(2);
    expect(repository.orderbookSnapshots).toHaveLength(4);
    expect(repository.opportunities).toHaveLength(2);
    expect(repository.paperTradeSimulations).toHaveLength(2);
    expect(repository.scanRuns).toHaveLength(2);
  });

  it("replaces scanRuns when saveScanRun is called with an existing id", async () => {
    const repository = new InMemoryScannerRepository();

    const result1 = await repository.saveCompletedScan(artifacts("scan-1"));
    expect(repository.scanRuns).toHaveLength(1);

    // saveScanRun with the same id should update, not append.
    await repository.saveScanRun({ ...result1, status: "failed", failureReason: "test failure" });
    expect(repository.scanRuns).toHaveLength(1);
    expect(repository.scanRuns[0]).toMatchObject({ id: "scan-1", status: "failed", failureReason: "test failure" });
  });
});
