// Behavior-level regression for the production paper-trade wiring P0.
//
// The contract being guarded: a `ReadOnlyScanner` constructed with a
// `PaperTradeSimulator` persists `paper_trade_simulations` rows for every
// opportunity it emits. This is the behavior `/v1/opportunities/:id/paper-trades`
// and the runbook depend on, and it is the reason `ScannerModule` injects
// the simulator into the production scanner. We assert it at the
// behavior level (persisted rows tied to the emitted opportunity) rather
// than reaching into private DI state, so the test survives field renames
// or minified class names as long as the wiring stays correct.
import { describe, expect, it } from "vitest";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { PaperTradeSimulator } from "../src/contexts/arbitrage/domain/paper-trade-simulator";
import { StaticVenueClient } from "../src/contexts/venues/application/static-venue-client";
import { venueMarketSnapshot, DEFAULT_RAW_RESOLUTION_TEXT } from "./helpers/markets";

const capturedAt = "2026-06-03T12:00:00.000Z";
// Fixture proven to emit one Class A opportunity in test/scanner.test.ts:
// Kalshi YES @ 0.42 + Polymarket NO @ 0.51 → combined cost 0.93 → net edge.
const kalshiClient = new StaticVenueClient({
  markets: [venueMarketSnapshot(capturedAt, "kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
  books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
});
const polymarketClient = new StaticVenueClient({
  markets: [venueMarketSnapshot(capturedAt, "polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", DEFAULT_RAW_RESOLUTION_TEXT)],
  books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
});

describe("ReadOnlyScanner paper-trade wiring (behavior)", () => {
  it("persists paper_trade_simulations rows for every emitted opportunity when a PaperTradeSimulator is wired", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient,
      polymarketClient,
      repository,
      paperTradeSimulator: new PaperTradeSimulator(),
      clock: () => capturedAt
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics.opportunitiesFound).toBeGreaterThan(0);
    expect(repository.opportunities.length).toBeGreaterThan(0);

    // The P0 contract: each emitted opportunity has persisted paper-trade
    // simulations tied to it. This is what would silently regress if
    // ScannerModule stopped injecting the simulator.
    expect(repository.paperTradeSimulations.length).toBeGreaterThan(0);

    const emittedOppIds = new Set(repository.opportunities.map((o) => o.opportunity.id));
    expect(repository.paperTradeSimulations.every((s) => emittedOppIds.has(s.opportunityId))).toBe(true);

    // Default target notionals [5, 25, 100, executableSizeUsd] deduped/sorted.
    const targets = new Set(repository.paperTradeSimulations.map((s) => s.targetNotionalUsd));
    expect(targets.has(5)).toBe(true);
    expect(targets.has(25)).toBe(true);
    expect(targets.has(100)).toBe(true);
  });

  it("emits zero paper_trade_simulations when no simulator is wired (proves the test is sensitive to the wiring)", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient,
      polymarketClient,
      repository,
      // paperTradeSimulator intentionally omitted — the pre-fix behavior.
      clock: () => capturedAt
    });

    await scanner.runOnce();

    expect(repository.opportunities.length).toBeGreaterThan(0);
    expect(repository.paperTradeSimulations).toHaveLength(0);
  });
});