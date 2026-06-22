import { describe, expect, it, vi } from "vitest";
import { ScanArtifactAssembler } from "../src/contexts/scanner/scan-artifact-assembler";
import { OpportunityCalculator } from "../src/contexts/arbitrage/domain/opportunity-calculator";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { NormalizedMarket } from "../src/contexts/matching/domain/normalized-market";
import { ReviewedCandidatePair } from "../src/contexts/scanner/scanner-repository";

const capturedAt = "2026-06-03T12:00:00.000Z";

function normalizedMarket(venue: "kalshi" | "polymarket", venueMarketId: string): NormalizedMarket {
  return {
    id: `${venue}:${venueMarketId}`,
    venue,
    venueMarketId,
    title: `Will BTC be above $100,000 on Jan 1, 2026?`,
    rawResolutionText: "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z",
    topic: "crypto",
    eventType: "price_above",
    asset: "BTC",
    threshold: 100000,
    operator: ">",
    deadline: "2026-01-01T00:00:00Z",
    payoffType: "at_time",
    ambiguityFlags: [],
    confidence: 0.95
  };
}

function book(venue: "kalshi" | "polymarket", marketId: string, overrides: Partial<MarketBook> = {}): MarketBook {
  return {
    marketId,
    venue,
    yesAsk: venue === "kalshi" ? 0.42 : 0.5,
    noAsk: venue === "kalshi" ? 0.62 : 0.51,
    yesAvailableUsd: venue === "kalshi" ? 20 : 50,
    noAvailableUsd: venue === "kalshi" ? 30 : 12,
    capturedAt,
    ...overrides
  };
}

describe("ScanArtifactAssembler", () => {
  describe("assembleOrderbookSnapshots", () => {
    it("maps each book to an orderbook snapshot artifact keyed by the matched normalized market", () => {
      const scanId = "scan-1";
      const assembler = new ScanArtifactAssembler();
      const normalizedMarkets = [
        normalizedMarket("kalshi", "K1"),
        normalizedMarket("polymarket", "P1")
      ];
      const books = [book("kalshi", "K1"), book("polymarket", "P1")];

      const snapshots = assembler.assembleOrderbookSnapshots(scanId, books, normalizedMarkets);

      expect(snapshots).toHaveLength(2);
      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `${scanId}:kalshi:K1:${capturedAt}`,
            scanRunId: scanId,
            normalizedMarketId: "kalshi:K1",
            venue: "kalshi",
            venueMarketId: "K1",
            yesAsk: 0.42,
            noAsk: 0.62,
            yesAvailableUsd: 20,
            noAvailableUsd: 30,
            capturedAt,
            stale: false
          }),
          expect.objectContaining({
            id: `${scanId}:polymarket:P1:${capturedAt}`,
            scanRunId: scanId,
            normalizedMarketId: "polymarket:P1",
            venue: "polymarket",
            venueMarketId: "P1"
          })
        ])
      );
    });

    it("drops a book whose venue/market has no matching normalized market", () => {
      const assembler = new ScanArtifactAssembler();
      const normalizedMarkets = [normalizedMarket("kalshi", "K1")];
      const books = [book("kalshi", "K1"), book("polymarket", "P1")];

      const snapshots = assembler.assembleOrderbookSnapshots("scan-1", books, normalizedMarkets);

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].venue).toBe("kalshi");
    });

    it("filters invalid ask prices (NaN, <=0, >=1) to undefined and preserves the stale flag", () => {
      const assembler = new ScanArtifactAssembler();
      const normalizedMarkets = [normalizedMarket("kalshi", "K1")];
      const books: MarketBook[] = [
        book("kalshi", "K1", { yesAsk: Number.NaN, noAsk: 1.5, stale: true })
      ];

      const [snapshot] = assembler.assembleOrderbookSnapshots("scan-1", books, normalizedMarkets);

      expect(snapshot.yesAsk).toBeUndefined();
      expect(snapshot.noAsk).toBeUndefined();
      expect(snapshot.stale).toBe(true);
    });

    it("builds the raw payload from the source book with default depth arrays", () => {
      const assembler = new ScanArtifactAssembler();
      const normalizedMarkets = [normalizedMarket("kalshi", "K1")];
      const books: MarketBook[] = [
        book("kalshi", "K1", { rawPayload: { id: "K1", extra: true }, yesDepth: [{ price: 0.4, size: 10 }] })
      ];

      const [snapshot] = assembler.assembleOrderbookSnapshots("scan-1", books, normalizedMarkets);

      expect(snapshot.rawPayload).toMatchObject({
        sourcePayload: { id: "K1", extra: true },
        marketId: "K1",
        venue: "kalshi",
        yesAsk: 0.42,
        noAsk: 0.62,
        yesAvailableUsd: 20,
        noAvailableUsd: 30,
        yesDepth: [{ price: 0.4, size: 10 }],
        noDepth: [],
        capturedAt,
        stale: false
      });
    });
  });

  describe("assembleOpportunities", () => {
    function reviewedPair(decision: Partial<EquivalenceDecision> = {}): ReviewedCandidatePair {
      const kalshi = normalizedMarket("kalshi", "K1");
      const polymarket = normalizedMarket("polymarket", "P1");
      const pair: CandidatePair = {
        id: "kalshi:K1:polymarket:P1",
        kalshiMarket: kalshi,
        polymarketMarket: polymarket,
        reasons: []
      };
      const fullDecision: EquivalenceDecision = {
        pairId: pair.id,
        equivalenceClass: "A",
        decision: "tradable",
        reasons: [],
        ...decision
      };
      return { pair, decision: fullDecision };
    }

    it("wires each emitted opportunity to the source orderbook snapshot ids for both legs", () => {
      const assembler = new ScanArtifactAssembler();
      const calculator = new OpportunityCalculator();
      const scanId = "scan-1";
      const normalizedMarkets = [normalizedMarket("kalshi", "K1"), normalizedMarket("polymarket", "P1")];
      const books = [book("kalshi", "K1"), book("polymarket", "P1")];
      const snapshots = assembler.assembleOrderbookSnapshots(scanId, books, normalizedMarkets);

      const opportunities = assembler.assembleOpportunities(
        [reviewedPair()],
        books,
        snapshots,
        capturedAt,
        calculator
      );

      expect(opportunities.length).toBeGreaterThan(0);
      const kalshiSnapshot = snapshots.find((s) => s.venue === "kalshi");
      const polymarketSnapshot = snapshots.find((s) => s.venue === "polymarket");
      for (const opp of opportunities) {
        expect(opp.kalshiOrderbookSnapshotId).toBe(kalshiSnapshot?.id);
        expect(opp.polymarketOrderbookSnapshotId).toBe(polymarketSnapshot?.id);
        expect(opp.opportunity.id).toContain("kalshi:K1:polymarket:P1");
      }
    });

    it("skips a pair when either leg's book or orderbook snapshot is missing", () => {
      const assembler = new ScanArtifactAssembler();
      const calculator = new OpportunityCalculator();
      const normalizedMarkets = [normalizedMarket("kalshi", "K1"), normalizedMarket("polymarket", "P1")];
      // Only the kalshi book present; polymarket book missing.
      const books = [book("kalshi", "K1")];
      const snapshots = assembler.assembleOrderbookSnapshots("scan-1", books, normalizedMarkets);

      const opportunities = assembler.assembleOpportunities(
        [reviewedPair()],
        books,
        snapshots,
        capturedAt,
        calculator
      );

      expect(opportunities).toHaveLength(0);
    });

    it("does not emit opportunities for a non-tradable (class B) pair", () => {
      const assembler = new ScanArtifactAssembler();
      const calculator = new OpportunityCalculator();
      const normalizedMarkets = [normalizedMarket("kalshi", "K1"), normalizedMarket("polymarket", "P1")];
      const books = [book("kalshi", "K1"), book("polymarket", "P1")];
      const snapshots = assembler.assembleOrderbookSnapshots("scan-1", books, normalizedMarkets);

      const opportunities = assembler.assembleOpportunities(
        [reviewedPair({ equivalenceClass: "B", decision: "alert_only" })],
        books,
        snapshots,
        capturedAt,
        calculator
      );

      // The calculator short-circuits class-B pairs internally, so no
      // opportunity is emitted and no snapshot id wiring happens.
      expect(opportunities).toHaveLength(0);
    });
  });
});