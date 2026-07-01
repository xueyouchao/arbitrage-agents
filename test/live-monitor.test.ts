import { describe, expect, it, vi } from "vitest";
import { toVerifiedOutput, ScanOutput, VerifiedEdge, buildAlerts, formatAlertLine, persistAlerts, AlertInsert, ALERT_CHANNEL_CONSOLE_DB } from "../runbook/live-monitor";
import { WorldCupArbResult, WorldCupArbOpportunity } from "../src/contexts/worldcup/application/worldcup-arb-finder";
import { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import { WorldCupCandidatePair } from "../src/contexts/worldcup/domain/worldcup-pair-matcher";

type VerifiedEdgeInput = Partial<VerifiedEdge>;

/**
 * Issue #75: live-monitor runbook output format tests.
 *
 * Verifies that toVerifiedOutput() keeps only fresh edges (dataStalenessMs
 * <= maxBookAgeMs) and skips stale ones, producing the clean ScanOutput
 * shape that the runbook prints on stdout.
 */

function makeOpportunity(overrides: Partial<CrossVenueOpportunity> = {}): CrossVenueOpportunity {
  return {
    id: "test:kalshi_yes-polymarket_no",
    pairId: "test",
    longLeg: { venue: "kalshi", marketId: "K1", side: "YES", askPrice: 0.4, availableUsd: 100 },
    hedgeLeg: { venue: "polymarket", marketId: "P1", side: "NO", askPrice: 0.5, availableUsd: 100 },
    combinedCost: 0.9,
    grossEdge: 0.1,
    estimatedFees: 0.009,
    estimatedSlippage: 0.004,
    netEdge: 0.087,
    theoreticalCombinedCost: 0.9,
    theoreticalGrossEdge: 0.1,
    theoreticalNetEdge: 0.087,
    executableSizeUsd: 100,
    executableCombinedCost: 0.9,
    executableGrossEdge: 0.1,
    executableNetEdge: 0.087,
    maxTradableUsd: 100,
    notionalEdges: [],
    equivalenceClass: "A",
    resolutionRisk: "low",
    fillRisk: "low",
    liquidityRisk: "low",
    venueRisk: "low",
    equivalenceRisk: "low",
    dataStalenessMs: 1000,
    opportunityAgeMs: 0,
    detectedAt: "2026-01-01T00:00:00.000Z",
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    calculationVersion: "opportunity-calculator-v2",
    configVersion: "phase3-conservative-v1",
    ...overrides,
  };
}

function makePair(overrides: Partial<WorldCupCandidatePair> = {}): WorldCupCandidatePair {
  return {
    id: "test",
    kalshiMarket: {
      venue: "kalshi",
      venueMarketId: "K1",
      teamCode: "bra",
      marketType: "winner",
      originalTitle: "Brazil to win",
    } as WorldCupCandidatePair["kalshiMarket"],
    polymarketMarket: {
      venue: "polymarket",
      venueMarketId: "P1",
      teamCode: "bra",
      marketType: "winner",
      originalTitle: "Will Brazil win?",
    } as WorldCupCandidatePair["polymarketMarket"],
    genericPair: { id: "test", kalshiMarket: {} as never, polymarketMarket: {} as never, reasons: [] },
    reasons: [],
    ...overrides,
  };
}

function makeResult(opps: WorldCupArbOpportunity[]): WorldCupArbResult {
  return {
    scannedAt: "2026-01-01T00:00:00.000Z",
    kalshiMarketCount: 1,
    polymarketMarketCount: 1,
    worldCupKalshi: 1,
    worldCupPolymarket: 1,
    candidatePairs: 1,
    opportunities: opps,
    timings: { fetchMarketsMs: 100, filterAndPairMs: 10, fetchOrderbooksMs: 50, calculateMs: 5, totalMs: 165 },
  };
}

describe("live-monitor toVerifiedOutput", () => {
  it("keeps fresh edges (dataStalenessMs <= maxBookAgeMs) and reports them in output", () => {
    const freshOpp: WorldCupArbOpportunity = {
      pair: makePair(),
      opportunity: makeOpportunity({ dataStalenessMs: 5_000, venueRisk: "low" }),
      paperTradeSimulations: [],
    };
    const result = makeResult([freshOpp]);

    const output = toVerifiedOutput(result, 60_000, 60_000);

    expect(output.summary.verifiedEdges).toBe(1);
    expect(output.summary.staleBooksFiltered).toBe(0);
    expect(output.edges).toHaveLength(1);
    expect(output.edges[0]).toMatchObject({
      team: "BRA",
      direction: "kalshi_yes/poly_no",
      netEdge: 0.087,
      dataStalenessMs: 5_000,
      venueRisk: "low",
    });
  });

  it("skips stale edges (dataStalenessMs > maxBookAgeMs) and counts them as filtered", () => {
    const staleOpp: WorldCupArbOpportunity = {
      pair: makePair(),
      opportunity: makeOpportunity({ dataStalenessMs: 90_000, venueRisk: "high" }),
      paperTradeSimulations: [],
    };
    const result = makeResult([staleOpp]);

    const output = toVerifiedOutput(result, 60_000, 60_000);

    expect(output.summary.verifiedEdges).toBe(0);
    expect(output.summary.staleBooksFiltered).toBe(1);
    expect(output.edges).toEqual([]);
  });

  it("separates fresh and stale edges within the same scan", () => {
    const fresh: WorldCupArbOpportunity = {
      pair: makePair({ id: "fresh" }),
      opportunity: makeOpportunity({ id: "fresh:kalshi_yes-polymarket_no", dataStalenessMs: 10_000 }),
      paperTradeSimulations: [],
    };
    const stale: WorldCupArbOpportunity = {
      pair: makePair({ id: "stale" }),
      opportunity: makeOpportunity({ id: "stale:kalshi_yes-polymarket_no", dataStalenessMs: 70_000 }),
      paperTradeSimulations: [],
    };
    const result = makeResult([fresh, stale]);

    const output = toVerifiedOutput(result, 60_000, 60_000);

    expect(output.summary.verifiedEdges).toBe(1);
    expect(output.summary.staleBooksFiltered).toBe(1);
    expect(output.edges).toHaveLength(1);
    expect(output.edges[0].id).toBe("fresh:kalshi_yes-polymarket_no");
  });

  it("accepts an edge exactly at the maxBookAgeMs boundary", () => {
    const boundary: WorldCupArbOpportunity = {
      pair: makePair(),
      opportunity: makeOpportunity({ dataStalenessMs: 60_000 }),
      paperTradeSimulations: [],
    };
    const result = makeResult([boundary]);

    const output = toVerifiedOutput(result, 60_000, 60_000);

    expect(output.summary.verifiedEdges).toBe(1);
    expect(output.edges[0].dataStalenessMs).toBe(60_000);
  });

  it("includes interval and maxBookAgeMs in the output for traceability", () => {
    const result = makeResult([]);

    const output = toVerifiedOutput(result, 45_000, 30_000);

    expect(output.intervalMs).toBe(30_000);
    expect(output.maxBookAgeMs).toBe(45_000);
    expect(output.scannedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("produces zero edges when the scan found no opportunities", () => {
    const result = makeResult([]);

    const output = toVerifiedOutput(result, 60_000, 60_000);

    expect(output.edges).toEqual([]);
    expect(output.summary.verifiedEdges).toBe(0);
    expect(output.summary.staleBooksFiltered).toBe(0);
  });
});

/**
 * Issue #76: alerting for verified edges.
 *
 * buildAlerts() takes a ScanOutput plus a min-edge threshold and returns
 * the alert records to persist into the `alerts` table (opportunity ID,
 * channel, payload). Edges at or above the threshold produce one alert
 * each; edges below the threshold are dropped.
 */
describe("live-monitor buildAlerts", () => {
  function makeScanOutput(edges: Partial<VerifiedEdgeInput>[]): ScanOutput {
    return {
      scannedAt: "2026-01-01T00:00:00.000Z",
      intervalMs: 60_000,
      maxBookAgeMs: 60_000,
      summary: {
        kalshiMarkets: 1,
        polymarketMarkets: 1,
        candidatePairs: 1,
        verifiedEdges: edges.length,
        staleBooksFiltered: 0,
      },
      timings: { fetchMarketsMs: 100, filterAndPairMs: 10, fetchOrderbooksMs: 50, calculateMs: 5, totalMs: 165 },
      edges: edges.map((e, i) => ({
        id: e.id ?? `id-${i}`,
        team: e.team ?? "BRA",
        marketType: e.marketType ?? "winner",
        opponent: e.opponent ?? null,
        direction: e.direction ?? "kalshi_yes/poly_no",
        grossEdge: e.grossEdge ?? 0.1,
        netEdge: e.netEdge ?? 0.05,
        maxTradableUsd: e.maxTradableUsd ?? 100,
        executableSizeUsd: e.executableSizeUsd ?? 100,
        dataStalenessMs: e.dataStalenessMs ?? 1000,
        venueRisk: e.venueRisk ?? "low",
        kalshiTitle: e.kalshiTitle ?? "Brazil to win",
        polymarketTitle: e.polymarketTitle ?? "Will Brazil win?",
        kalshiYesAsk: e.kalshiYesAsk ?? 0.4,
        polymarketNoAsk: e.polymarketNoAsk ?? 0.5,
      })),
    };
  }

  it("creates an alert record with the correct fields for a verified edge above threshold", () => {
    const output = makeScanOutput([{ id: "opp-1", team: "BRA", netEdge: 0.05, maxTradableUsd: 100 }]);

    const alerts = buildAlerts(output, { minEdge: 0.02 });

    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as AlertInsert;
    expect(alert.opportunityId).toBe("opp-1");
    expect(alert.channel).toBe(ALERT_CHANNEL_CONSOLE_DB);
    expect(alert.payload).toMatchObject({
      team: "BRA",
      direction: "kalshi_yes/poly_no",
      netEdge: 0.05,
      maxTradableUsd: 100,
      kalshiTitle: "Brazil to win",
      polymarketTitle: "Will Brazil win?",
    });
  });

  it("creates one alert per qualifying edge", () => {
    const output = makeScanOutput([
      { id: "a", netEdge: 0.03 },
      { id: "b", netEdge: 0.04 },
      { id: "c", netEdge: 0.05 },
    ]);

    const alerts = buildAlerts(output, { minEdge: 0.02 });

    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.opportunityId)).toEqual(["a", "b", "c"]);
  });
});

/**
 * Issue #76: console alert line format.
 *
 * formatAlertLine() returns a single human-readable string containing
 * team, direction, net edge %, venue prices, and max tradable USD.
 */
describe("live-monitor formatAlertLine", () => {
  it("includes team, direction, net edge %, venue prices, and max tradable USD", () => {
    const edge: ScanOutput["edges"][number] = {
      id: "opp-1",
      team: "BRA",
      marketType: "winner",
      opponent: null,
      direction: "kalshi_yes/poly_no",
      grossEdge: 0.1,
      netEdge: 0.05,
      maxTradableUsd: 100,
      executableSizeUsd: 100,
      dataStalenessMs: 1000,
      venueRisk: "low",
      kalshiTitle: "Brazil to win",
      polymarketTitle: "Will Brazil win?",
      kalshiYesAsk: 0.4,
      polymarketNoAsk: 0.5,
    };

    const line = formatAlertLine(edge);

    expect(line).toContain("BRA");
    expect(line).toContain("kalshi_yes/poly_no");
    expect(line).toContain("5.00%");
    expect(line).toContain("$100.00");
    expect(line).toContain("0.40");
    expect(line).toContain("0.50");
  });
});

/**
 * Issue #76: threshold filtering — edges below threshold do NOT produce alerts.
 */
describe("live-monitor buildAlerts threshold filtering", () => {
  function makeScanOutput(edges: Partial<VerifiedEdgeInput>[]): ScanOutput {
    return {
      scannedAt: "2026-01-01T00:00:00.000Z",
      intervalMs: 60_000,
      maxBookAgeMs: 60_000,
      summary: {
        kalshiMarkets: 1,
        polymarketMarkets: 1,
        candidatePairs: 1,
        verifiedEdges: edges.length,
        staleBooksFiltered: 0,
      },
      timings: { fetchMarketsMs: 100, filterAndPairMs: 10, fetchOrderbooksMs: 50, calculateMs: 5, totalMs: 165 },
      edges: edges.map((e, i) => ({
        id: e.id ?? `id-${i}`,
        team: e.team ?? "BRA",
        marketType: e.marketType ?? "winner",
        opponent: e.opponent ?? null,
        direction: e.direction ?? "kalshi_yes/poly_no",
        grossEdge: e.grossEdge ?? 0.1,
        netEdge: e.netEdge ?? 0.05,
        maxTradableUsd: e.maxTradableUsd ?? 100,
        executableSizeUsd: e.executableSizeUsd ?? 100,
        dataStalenessMs: e.dataStalenessMs ?? 1000,
        venueRisk: e.venueRisk ?? "low",
        kalshiTitle: e.kalshiTitle ?? "Brazil to win",
        polymarketTitle: e.polymarketTitle ?? "Will Brazil win?",
        kalshiYesAsk: e.kalshiYesAsk ?? 0.4,
        polymarketNoAsk: e.polymarketNoAsk ?? 0.5,
      })),
    };
  }

  it("does not create alerts for edges below the min-edge threshold", () => {
    const output = makeScanOutput([
      { id: "below", netEdge: 0.005 },
      { id: "at", netEdge: 0.02 },
      { id: "above", netEdge: 0.05 },
    ]);

    const alerts = buildAlerts(output, { minEdge: 0.02 });

    expect(alerts.map((a) => a.opportunityId)).toEqual(["at", "above"]);
  });

  it("produces zero alerts when all edges are below threshold", () => {
    const output = makeScanOutput([{ id: "a", netEdge: 0.001 }, { id: "b", netEdge: 0.005 }]);

    const alerts = buildAlerts(output, { minEdge: 0.02 });

    expect(alerts).toEqual([]);
  });
});

/**
 * Issue #76: persistAlerts issues the correct INSERT against the alerts
 * table, using the stable-id-derived opportunity UUID and the jsonb payload.
 */
describe("live-monitor persistAlerts", () => {
  it("inserts one row per alert with opportunity UUID, channel, and jsonb payload", async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    const queryFn = vi.fn(async (text: string, params: unknown[]) => {
      queries.push({ text, params });
      return undefined;
    });

    const alerts: AlertInsert[] = [
      {
        opportunityId: "opp-1",
        channel: ALERT_CHANNEL_CONSOLE_DB,
        payload: { team: "BRA", netEdge: 0.05 },
      },
    ];

    await persistAlerts(alerts, queryFn);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("insert into alerts");
    expect(queries[0].text).toContain("opportunity_id");
    expect(queries[0].text).toContain("channel");
    expect(queries[0].text).toContain("payload");
    // The opportunity UUID is derived from the stable key via uuidFromStableKey.
    const { uuidFromStableKey } = await import("../src/contexts/shared/stable-id");
    expect(queries[0].params[0]).toBe(uuidFromStableKey("opp-1"));
    expect(queries[0].params[1]).toBe(ALERT_CHANNEL_CONSOLE_DB);
    // Payload is serialized JSON containing the alert fields.
    const payloadJson = queries[0].params[2] as string;
    const parsed = JSON.parse(payloadJson);
    expect(parsed).toMatchObject({ team: "BRA", netEdge: 0.05 });
  });

  it("does not call the query function when there are no alerts", async () => {
    const queryFn = vi.fn(async () => undefined);
    await persistAlerts([], queryFn);
    expect(queryFn).not.toHaveBeenCalled();
  });
});