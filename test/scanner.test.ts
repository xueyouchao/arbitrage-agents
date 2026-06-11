import { describe, expect, it, vi } from "vitest";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { WorkerScanRunner } from "../src/contexts/scanner/worker-scan-runner";
import { StaticVenueClient } from "../src/contexts/venues/application/static-venue-client";
import { VenueClient, VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";
import { CompletedScanArtifacts, CompletedScanResult } from "../src/contexts/scanner/scanner-repository";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import { PersistedLlmGateway } from "../src/contexts/llm/application/persisted-llm-gateway";

const capturedAt = "2026-06-03T12:00:00.000Z";

function market(venue: "kalshi" | "polymarket", id: string, title: string, rawResolutionText = "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z"): VenueMarketSnapshot {
  return {
    venue,
    venueMarketId: id,
    title,
    rawResolutionText,
    rawPayload: { id, title },
    capturedAt
  };
}

describe("ReadOnlyScanner", () => {
  it("persists scan runs, snapshots, normalized markets, pairs, and opportunities without trading", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      clock: sequenceClock([
        "2026-06-03T11:59:59.000Z",
        capturedAt,
        "2026-06-03T12:00:01.000Z"
      ])
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.startedAt).toBe("2026-06-03T11:59:59.000Z");
    expect(result.completedAt).toBe("2026-06-03T12:00:01.000Z");
    expect(result.metrics).toMatchObject({
      marketsScanned: 2,
      normalizedMarkets: 2,
      candidatePairs: 1,
      opportunitiesFound: 1
    });
    expect(repository.snapshots).toHaveLength(2);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.candidatePairs[0].decision).toMatchObject({
      equivalenceClass: "A",
      decision: "tradable"
    });
    expect(repository.orderbookSnapshots).toHaveLength(2);
    expect(repository.orderbookSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          scanRunId: result.id,
          normalizedMarketId: "kalshi:K1",
          venue: "kalshi",
          venueMarketId: "K1",
          yesAsk: 0.42,
          noAsk: 0.62,
          yesAvailableUsd: 20,
          noAvailableUsd: 30,
          capturedAt,
          stale: false,
          rawPayload: expect.objectContaining({ marketId: "K1", venue: "kalshi" })
        }),
        expect.objectContaining({
          id: expect.any(String),
          scanRunId: result.id,
          normalizedMarketId: "polymarket:P1",
          venue: "polymarket",
          venueMarketId: "P1",
          yesAsk: 0.5,
          noAsk: 0.51,
          yesAvailableUsd: 50,
          noAvailableUsd: 12,
          capturedAt,
          stale: false,
          rawPayload: expect.objectContaining({ marketId: "P1", venue: "polymarket" })
        })
      ])
    );
    expect(repository.opportunities).toHaveLength(1);
    expect(repository.opportunities[0]).toMatchObject({
      opportunity: expect.objectContaining({ id: "kalshi:K1:polymarket:P1:kalshi_yes-polymarket_no" }),
      kalshiOrderbookSnapshotId: repository.orderbookSnapshots.find((snapshot) => snapshot.venue === "kalshi")?.id,
      polymarketOrderbookSnapshotId: repository.orderbookSnapshots.find((snapshot) => snapshot.venue === "polymarket")?.id
    });
  });

  it("uses the injected scan time for opportunity freshness", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.startedAt).toBe(capturedAt);
    expect(result.completedAt).toBe(capturedAt);
    expect(repository.opportunities[0].opportunity.detectedAt).toBe(capturedAt);
    expect(result.metrics.opportunitiesFound).toBe(1);
  });

  it("persists stale orderbook snapshots without emitting opportunities", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 1, noAsk: 0.62, yesAvailableUsd: 0, noAvailableUsd: 30, capturedAt, stale: true }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics.opportunitiesFound).toBe(0);
    expect(repository.orderbookSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scanRunId: result.id,
          venue: "kalshi",
          venueMarketId: "K1",
          yesAsk: undefined,
          noAsk: 0.62,
          stale: true
        })
      ])
    );
    expect(repository.opportunities).toHaveLength(0);
  });

  it("records sanitized fetch failures", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: failingClient("Kalshi failed: https://secret.test/book?token_id=abc&api_key=secret"),
      polymarketClient: new StaticVenueClient({ markets: [], books: [] }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "fetch",
      failureReason: "Kalshi failed: [redacted-url]"
    });
    expect(result.metrics).toMatchObject({
      failureCategory: "fetch",
      failureReason: "Kalshi failed: [redacted-url]"
    });
    expect(repository.scanRuns.at(-1)).toMatchObject(result);
  });

  it("records sanitized processing failures", async () => {
    const repository = new InMemoryScannerRepository();
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", "Resolves using Coinbase BTC/USD at 2026-99-99T00:00:00Z")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "processing"
    });
    expect(result.metrics.marketsScanned).toBe(2);
    expect(result.failureReason).not.toContain("secret");
    expect(repository.scanRuns.at(-1)).toMatchObject(result);
  });

  it("records sanitized persistence failures", async () => {
    const repository = new FailingCompletedScanRepository("insert failed for Authorization: Bearer secret");
    const scanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      now: capturedAt
    });

    const result = await scanner.runOnce();

    expect(result).toMatchObject({
      status: "failed",
      failureCategory: "persistence",
      failureReason: "insert failed for Authorization: [REDACTED]"
    });
    expect(result.metrics.opportunitiesFound).toBe(1);
    expect(repository.scanRuns.at(-1)).toMatchObject(result);
  });

  it("throws when the worker scanner result fails", async () => {
    const scanner = {
      runOnce: vi.fn(async () => ({
        id: "scan-1",
        status: "failed" as const,
        startedAt: capturedAt,
        completedAt: capturedAt,
        metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 },
        failureCategory: "fetch" as const,
        failureReason: "Kalshi failed: [redacted-url]"
      }))
    } as Pick<ReadOnlyScanner, "runOnce"> as ReadOnlyScanner;

    await expect(new WorkerScanRunner(scanner).runOnce()).rejects.toThrow("Scan failed (fetch): Kalshi failed: [redacted-url]");
  });

  it("fetches orderbooks only after freshly fetched markets", async () => {
    const kalshiMarkets = [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?")];
    const polymarketMarkets = [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?")];
    const calls: string[] = [];
    const kalshiClient = sequencingClient("kalshi", kalshiMarkets, [
      { marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }
    ], calls);
    const polymarketClient = sequencingClient("polymarket", polymarketMarkets, [
      { marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }
    ], calls);

    const result = await new ReadOnlyScanner({
      kalshiClient,
      polymarketClient,
      repository: new InMemoryScannerRepository(),
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(calls.slice(0, 2)).toEqual(["kalshi:markets", "polymarket:markets"]);
    expect(calls).toContain("kalshi:books:K1");
    expect(calls).toContain("polymarket:books:P1");
    expect(kalshiClient.listOrderbooks).toHaveBeenCalledWith(kalshiMarkets);
    expect(polymarketClient.listOrderbooks).toHaveBeenCalledWith(polymarketMarkets);
  });

  it("uses schema-validated LLM normalization before candidate generation", async () => {
    const repository = new InMemoryScannerRepository();
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => ({
      output: {
        topic: "crypto",
        eventType: "price_above",
        asset: "BTC",
        threshold: 100000,
        operator: ">",
        deadline: "2026-01-01T00:00:00.000Z",
        timezone: "UTC",
        resolutionSource: "Coinbase BTC/USD",
        payoffType: "at_time",
        confidence: 0.9,
        ambiguityFlags: []
      },
      tokenUsage: { promptTokens: 8, completionTokens: 4 },
      latencyMs: 15
    }));
    const rawResolutionText = "Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z.";

    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above one hundred thousand on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC exceed one hundred thousand on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      llmGateway,
      llmModel: "test-model",
      llmPromptVersion: "scanner-test-v1",
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics.llmEvaluations).toBe(3);
    expect(repository.normalizedMarkets).toEqual(expect.arrayContaining([
      expect.objectContaining({ threshold: 100000, ambiguityFlags: ["llm_normalized"] })
    ]));
    expect(repository.candidatePairs).toHaveLength(1);
    expect(repository.candidatePairs[0].llmEvaluation).toMatchObject({ taskType: "market_equivalence", status: "failed" });
  });

  it("caps scanner LLM evaluations per scan", async () => {
    const repository = new InMemoryScannerRepository();
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => ({
      output: {
        topic: "crypto",
        eventType: "price_above",
        asset: "BTC",
        threshold: 100000,
        operator: ">",
        deadline: "2026-01-01T00:00:00.000Z",
        timezone: "UTC",
        resolutionSource: null,
        payoffType: "at_time",
        confidence: 0.8,
        ambiguityFlags: ["resolution_source_missing"]
      }
    }));

    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", "Resolves if BTC is above $100,000 at 2026-01-01T00:00:00Z.")],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", "Resolves if BTC is above $100,000 at 2026-01-01T00:00:00Z.")],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      llmGateway,
      scannerLlmMaxEvaluationsPerScan: 1,
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics).toMatchObject({ llmEvaluations: 1, llmEvaluationsSkipped: 2 });
    expect(llmRepository.records).toHaveLength(1);
  });

  it("persists schema-validated LLM reviews for ambiguous scanner decisions", async () => {
    const repository = new InMemoryScannerRepository();
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async (request) => ({
      output: request.taskType === "market_equivalence"
        ? { equivalent: true, confidence: 0.72, explanation: "same BTC threshold, source still needs review" }
        : {
            topic: "crypto",
            eventType: "price_above",
            asset: "BTC",
            threshold: 100000,
            operator: ">",
            deadline: "2026-01-01T00:00:00.000Z",
            timezone: "UTC",
            resolutionSource: null,
            payoffType: "at_time",
            confidence: 0.8,
            ambiguityFlags: ["resolution_source_missing"]
          },
      tokenUsage: { promptTokens: 12, completionTokens: 6 },
      latencyMs: 20
    }));
    const rawResolutionText = "Resolves if BTC is above $100,000 at 2026-01-01T00:00:00Z.";

    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      llmGateway,
      llmModel: "test-model",
      llmPromptVersion: "scanner-test-v1",
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(result.metrics.llmEvaluations).toBe(3);
    expect(llmRepository.records.map((record) => record.taskType)).toEqual([
      "market_normalization",
      "market_normalization",
      "market_equivalence"
    ]);
    expect(llmRepository.records.every((record) => record.status === "succeeded")).toBe(true);
    expect(repository.candidatePairs[0]).toMatchObject({
      decision: expect.objectContaining({
        equivalenceClass: "B",
        decision: "alert_only",
        reasons: expect.arrayContaining(["resolution_source_missing", "llm_supported_equivalence"])
      }),
      llmEvaluation: expect.objectContaining({ taskType: "market_equivalence", parsedOutput: expect.objectContaining({ equivalent: true }) })
    });
    expect(repository.opportunities).toHaveLength(0);
  });

});

function sequenceClock(values: string[]): () => string {
  return () => values.shift() ?? values[values.length - 1] ?? new Date(0).toISOString();
}

function failingClient(message: string): VenueClient {
  return {
    listMarkets: vi.fn(async () => {
      throw new Error(message);
    }),
    listOrderbooks: vi.fn(async () => [])
  };
}

class FailingCompletedScanRepository extends InMemoryScannerRepository {
  constructor(private readonly message: string) {
    super();
  }

  async saveCompletedScan(_artifacts: CompletedScanArtifacts): Promise<CompletedScanResult> {
    throw new Error(this.message);
  }
}

function sequencingClient(
  venue: "kalshi" | "polymarket",
  markets: VenueMarketSnapshot[],
  books: MarketBook[],
  calls: string[]
): VenueClient & { listOrderbooks: ReturnType<typeof vi.fn> } {
  return {
    listMarkets: vi.fn(async () => {
      calls.push(`${venue}:markets`);
      return markets;
    }),
    listOrderbooks: vi.fn(async (freshMarkets: VenueMarketSnapshot[]) => {
      calls.push(`${venue}:books:${freshMarkets.map((freshMarket) => freshMarket.venueMarketId).join(",")}`);
      return books;
    })
  };
}
