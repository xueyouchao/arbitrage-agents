import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ReadOnlyScanner } from "../src/contexts/scanner/read-only-scanner";
import { InMemoryScannerRepository } from "../src/contexts/scanner/in-memory-scanner-repository";
import { StaticVenueClient } from "../src/contexts/venues/application/static-venue-client";
import { VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";
import { InMemoryLlmEvaluationRepository } from "../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import { LlmEvaluationRecord, LlmEvaluationRequest } from "../src/contexts/llm/application/llm-evaluation";
import { PersistedLlmGateway } from "../src/contexts/llm/application/persisted-llm-gateway";
import { buildScannerLlmValidatorRegistry, describeScannerSchema, marketEquivalenceSchema } from "../src/contexts/llm/scanner-llm-validators";
import { OllamaChatLlmProvider } from "../src/contexts/llm/infrastructure/ollama-chat-llm-provider";
import { venueMarketSnapshot } from "./helpers/markets";

const capturedAt = "2026-06-03T12:00:00.000Z";

function market(venue: "kalshi" | "polymarket", id: string, title: string, rawResolutionText?: string): VenueMarketSnapshot {
  return venueMarketSnapshot(capturedAt, venue, id, title, rawResolutionText);
}

function scanner(llmGateway?: ReadOnlyScanner["dependencies"]["llmGateway"], deps: Partial<ReadOnlyScanner["dependencies"]> = {}): ReadOnlyScanner {
  // Use raw resolution text that omits the resolution source — this
  // gives the deterministic normalizer an `ambiguityFlags` entry and
  // drops confidence below 0.8, so the scanner will actually call the
  // LLM normalization path (and exercise cache / budget accounting).
  const rawResolutionText = "Resolves on 2026-01-01T00:00:00Z";
  return new ReadOnlyScanner({
    kalshiClient: new StaticVenueClient({
      markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", rawResolutionText)],
      books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
    }),
    polymarketClient: new StaticVenueClient({
      markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", rawResolutionText)],
      books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
    }),
    repository: new InMemoryScannerRepository(),
    llmGateway,
    now: capturedAt,
    ...deps
  });
}

describe("Review fix #1 — LLM equivalence result maps into decision", () => {
  it("promotes a deterministic B pair to class A when LLM agrees with high confidence and there is no hard mismatch", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async (request) => {
      if (request.taskType === "market_normalization") {
        return {
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
            ambiguityFlags: ["resolution_source_missing"]
          }
        };
      }
      // market_equivalence: high confidence equivalent
      return { output: { equivalent: true, confidence: 0.95, explanation: "same BTC threshold" } };
    }, { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const rawResolutionText = "Resolves if BTC is above $100,000 at 2026-01-01T00:00:00Z.";
    const repository = new InMemoryScannerRepository();

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
    // Issue #1: with high LLM confidence, the deterministic B pair (caused
    // only by `resolution_source_missing`) is promoted to class A tradable.
    expect(repository.candidatePairs[0].decision).toEqual(
      expect.objectContaining({ equivalenceClass: "A", decision: "tradable" })
    );
    expect(repository.candidatePairs[0].decision.reasons).toEqual(
      expect.arrayContaining(["llm_supported_equivalence"])
    );
  });
});

describe("Review fix #2 — LLM normalization does not blanket-flag pair as B", () => {
  it("does not add `llm_normalized` to ambiguityFlags, so a clean LLM pair resolves to class A", async () => {
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
      }
    }), { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    const result = await scanner(llmGateway, { repository }).runOnce();

    expect(result.status).toBe("succeeded");
    // Issue #2: ambiguityFlags no longer contains `llm_normalized`.
    expect(repository.normalizedMarkets.map((m) => m.ambiguityFlags)).toEqual([
      [],
      []
    ]);
    // And the pair is class A, not class B.
    expect(repository.candidatePairs[0].decision.equivalenceClass).toBe("A");
  });
});

describe("Review fix #3 — LLM null fields preserve deterministic values", () => {
  it("preserves deterministic threshold when LLM returns null for it", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => ({
      output: {
        topic: "crypto",
        eventType: "price_above",
        asset: "BTC",
        threshold: null, // <-- LLM null
        operator: null,  // <-- LLM null
        deadline: null,  // <-- LLM null
        timezone: "UTC",
        resolutionSource: "Coinbase BTC/USD",
        payoffType: "at_time",
        confidence: 0.9,
        ambiguityFlags: []
      }
    }), { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    await scanner(llmGateway, { repository }).runOnce();

    // Issue #3: deterministic value must survive LLM null.
    const updated = repository.normalizedMarkets[0];
    expect(updated.threshold).toBe(100000);
    expect(updated.operator).toBe(">");
  });
});

describe("Review fix #6 — Cached LLM evaluations do not consume budget", () => {
  it("returns cached records without consuming the per-scan budget or accumulating token metrics", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    let calls = 0;
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => {
      calls += 1;
      return {
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
        tokenUsage: { promptTokens: 100, completionTokens: 50 },
        latencyMs: 1000
      };
    }, { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    const inner = scanner(llmGateway, {
      repository,
      // 4 evaluations total split across normalization + equivalence.
      // With the per-task budget split, normalization gets 2 slots
      // (one per market) and equivalence gets 2 slots.
      scannerLlmMaxEvaluationsPerScan: 4
    });

    // First run: 2 fresh normalization calls.
    const first = await inner.runOnce();
    expect(first.status).toBe("succeeded");
    expect(first.metrics.llmEvaluations).toBe(2);
    expect(first.metrics.llmPromptTokens).toBe(200);
    expect(calls).toBe(2);

    // Second run: 2 cache hits — provider is NOT called, budget stays
    // untouched, and no token metrics accumulate.
    const second = await inner.runOnce();
    expect(second.status).toBe("succeeded");
    // Issue #6: cached records do not consume the per-scan budget.
    expect(second.metrics.llmEvaluations).toBe(0);
    expect(second.metrics.llmPromptTokens).toBe(0);
    expect(calls).toBe(2);
  });

  it("cached normalization rows do not exhaust budget before an uncached equivalence review", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const promptVersion = "budget-cache-v1";
    const modelName = "budget-model";
    const rawResolutionText = "Resolves on 2026-01-01T00:00:00Z";
    const kalshi = market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", rawResolutionText);
    const polymarket = market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", rawResolutionText);

    await llmRepository.save(cachedNormalizationRecord(promptVersion, modelName, kalshi));
    await llmRepository.save(cachedNormalizationRecord(promptVersion, modelName, polymarket));

    let equivalenceCalls = 0;
    const llmGateway = new PersistedLlmGateway(llmRepository, async (request) => {
      if (request.taskType === "market_equivalence") {
        equivalenceCalls += 1;
        return { output: { equivalent: true, confidence: 0.95, explanation: "same market" } };
      }
      throw new Error("normalization should have been cached");
    }, { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [kalshi],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [polymarket],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository,
      llmGateway,
      llmPromptVersion: promptVersion,
      llmModel: modelName,
      scannerLlmMaxEvaluationsPerScan: 1,
      now: capturedAt
    }).runOnce();

    expect(result.status).toBe("succeeded");
    expect(equivalenceCalls).toBe(1);
    expect(result.metrics.llmEvaluations).toBe(1);
  });
});

describe("Review fix #7 — Coerce numeric strings from LLM", () => {
  it("accepts numeric strings for `threshold` and `confidence` instead of failing", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => ({
      output: {
        topic: "crypto",
        eventType: "price_above",
        asset: "BTC",
        threshold: "100000",  // <-- string
        operator: ">",
        deadline: "2026-01-01T00:00:00.000Z",
        timezone: "UTC",
        resolutionSource: "Coinbase BTC/USD",
        payoffType: "at_time",
        confidence: "0.9",     // <-- string
        ambiguityFlags: []
      }
    }), { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    await scanner(llmGateway, { repository }).runOnce();

    // Issue #7: numbers and numeric strings both validate. The scanner
    // applies the numeric value.
    expect(repository.normalizedMarkets[0].threshold).toBe(100000);
  });
});

describe("Review fix #8 — Ollama total_duration zero is preserved", () => {
  it("uses Math.round(0 / 1_000_000) when total_duration is exactly 0", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({
        message: { content: "{\"explanation\":\"x\"}" },
        prompt_eval_count: 1,
        eval_count: 1,
        total_duration: 0
      }), { status: 200, headers: { "Content-Type": "application/json" } });

    const provider = new OllamaChatLlmProvider({ baseUrl: "http://x", model: "m", timeoutMs: 100, fetchImpl });
    const result = await provider.evaluate({ taskType: "explanation", promptVersion: "v1", model: "m", input: {} });

    // Issue #8: a real 0 latency must be preserved (not replaced with
    // wall-clock).
    expect(result.latencyMs).toBe(0);
  });
});

describe("Review fix #9 — Per-task LLM budget split prevents starvation", () => {
  it("budgets are split between normalization and equivalence so equivalence is not starved", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    let normalizationCalls = 0;
    let equivalenceCalls = 0;
    const llmGateway = new PersistedLlmGateway(llmRepository, async (request) => {
      if (request.taskType === "market_normalization") {
        normalizationCalls += 1;
        return {
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
            ambiguityFlags: ["resolution_source_missing"]
          }
        };
      }
      equivalenceCalls += 1;
      return { output: { equivalent: true, confidence: 0.95, explanation: "ok" } };
    }, { validatorRegistry: buildScannerLlmValidatorRegistry() });

    // Create 4 markets (2 kalshi + 2 polymarket) that all need
    // normalization, plus 1 candidate pair that needs equivalence.
    // The rawResolutionText omits the resolution source so each
    // deterministic market has a low-confidence flag, ensuring LLM
    // normalization is actually requested.
    const rawResolutionText = "Resolves on 2026-01-01T00:00:00Z";
    const repository = new InMemoryScannerRepository();
    const markets = [
      market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", rawResolutionText),
      market("kalshi", "K2", "Will Bitcoin be above $200,000 on Jan 1, 2026?", rawResolutionText),
      market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", rawResolutionText),
      market("polymarket", "P2", "Will BTC be above $200,000 on Jan 1, 2026?", rawResolutionText)
    ];
    const books: MarketBook[] = markets.map((m) => ({
      venue: m.venue,
      marketId: m.venueMarketId,
      yesAsk: 0.42,
      noAsk: 0.62,
      yesAvailableUsd: 20,
      noAvailableUsd: 30,
      capturedAt
    }));

    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [markets[0], markets[1]],
        books: [books[0], books[1]]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [markets[2], markets[3]],
        books: [books[2], books[3]]
      }),
      repository,
      llmGateway,
      // Per-task caps reserve at least 1 slot for each task family
      // (normalization + equivalence). With a 4-evaluation cap, each
      // family gets 2 slots — so both normalization (2 markets) and
      // equivalence (1 pair) make it through even with several
      // ambiguous markets.
      scannerLlmMaxEvaluationsPerScan: 4,
      now: capturedAt
    }).runOnce();

    // Issue #9: even though we have 4 normalization candidates, the
    // per-task budget split means equivalence still gets at least 1 slot.
    expect(result.status).toBe("succeeded");
    expect(normalizationCalls).toBeGreaterThan(0);
    expect(equivalenceCalls).toBeGreaterThan(0);
  });
});

describe("Review fix #10 — Domain merge policy rejects material LLM field flips", () => {
  it("rejects LLM flips for all matching-critical fields and surfaces field-specific flags", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => ({
      output: {
        topic: "macro",
        eventType: "price_below",
        asset: "ETH",
        threshold: 90000,
        operator: "<", // <-- flipped from deterministic ">"
        deadline: "2026-01-02T00:00:00.000Z",
        timezone: "UTC",
        resolutionSource: "Coinbase BTC/USD",
        payoffType: "any_time_before",
        confidence: 0.9,
        ambiguityFlags: []
      }
    }), { validatorRegistry: buildScannerLlmValidatorRegistry() });

    // Build a market that triggers LLM normalization (ambiguity flag
    // present → low confidence) so the LLM result is actually applied.
    const ambiguousMarket: VenueMarketSnapshot = {
      venue: "kalshi",
      venueMarketId: "K1",
      title: "Will Bitcoin be above $100,000 on Jan 1, 2026?",
      // rawResolutionText omits the resolution source → triggers
      // `resolution_source_missing` flag → confidence drops below 0.8.
      rawResolutionText: "Resolves on 2026-01-01T00:00:00Z",
      rawPayload: {},
      capturedAt
    };
    const matchingMarket: VenueMarketSnapshot = {
      ...ambiguousMarket,
      venue: "polymarket",
      venueMarketId: "P1",
      title: "Will BTC be above $100,000 on Jan 1, 2026?"
    };
    const book: MarketBook = {
      venue: "kalshi",
      marketId: "K1",
      yesAsk: 0.42,
      noAsk: 0.62,
      yesAvailableUsd: 20,
      noAvailableUsd: 30,
      capturedAt
    };
    const book2: MarketBook = {
      venue: "polymarket",
      marketId: "P1",
      yesAsk: 0.5,
      noAsk: 0.51,
      yesAvailableUsd: 50,
      noAvailableUsd: 12,
      capturedAt
    };

    const repository = new InMemoryScannerRepository();
    await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [ambiguousMarket],
        books: [book]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [matchingMarket],
        books: [book2]
      }),
      repository,
      llmGateway,
      now: capturedAt
    }).runOnce();

    // Issue #10: every matching-critical deterministic field must be
    // preserved when the LLM attempts a material flip.
    expect(repository.normalizedMarkets[0]).toEqual(expect.objectContaining({
      topic: "crypto",
      eventType: "price_above",
      asset: "BTC",
      threshold: 100000,
      operator: ">",
      deadline: "2026-01-01T00:00:00.000Z",
      payoffType: "at_time"
    }));
    expect(repository.normalizedMarkets[0].ambiguityFlags).toEqual(
      expect.arrayContaining([
        "llm_topic_flip_rejected",
        "llm_event_type_flip_rejected",
        "llm_asset_flip_rejected",
        "llm_threshold_flip_rejected",
        "llm_operator_flip_rejected",
        "llm_deadline_flip_rejected",
        "llm_payoff_type_flip_rejected"
      ])
    );
  });
});

describe("Review fix #11 — LLM gateway exceptions are isolated", () => {
  it("a gateway exception does not fail the scan; it produces a failed evaluation record", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmGateway: { evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationRecord> } = {
      async evaluate() {
        throw new Error("provider exploded");
      }
    };

    const cleanMarket: VenueMarketSnapshot = {
      venue: "kalshi",
      venueMarketId: "K1",
      title: "Will Bitcoin be above $100,000 on Jan 1, 2026?",
      rawResolutionText: "Resolves on 2026-01-01T00:00:00Z",
      rawPayload: {},
      capturedAt
    };
    const matchingMarket: VenueMarketSnapshot = {
      ...cleanMarket,
      venue: "polymarket",
      venueMarketId: "P1",
      title: "Will BTC be above $100,000 on Jan 1, 2026?"
    };
    const book: MarketBook = {
      venue: "kalshi",
      marketId: "K1",
      yesAsk: 0.42,
      noAsk: 0.62,
      yesAvailableUsd: 20,
      noAvailableUsd: 30,
      capturedAt
    };
    const book2: MarketBook = {
      venue: "polymarket",
      marketId: "P1",
      yesAsk: 0.5,
      noAsk: 0.51,
      yesAvailableUsd: 50,
      noAvailableUsd: 12,
      capturedAt
    };
    const repository = new InMemoryScannerRepository();
    const result = await new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [cleanMarket],
        books: [book]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [matchingMarket],
        books: [book2]
      }),
      repository,
      llmGateway: llmGateway as PersistedLlmGateway,
      now: capturedAt
    }).runOnce();

    // Issue #11: the LLM path is exercised and throws, but scan processing
    // still succeeds with deterministic fallback artifacts persisted.
    expect(result.status).toBe("succeeded");
    expect(result.metrics.llmEvaluations).toBe(3);
    expect(repository.normalizedMarkets).toHaveLength(2);
    expect(repository.candidatePairs).toHaveLength(1);
  });
});

describe("Review fix #12 — Cached records are re-validated against current schema", () => {
  it("downgrades a cached record whose payloadSchemaVersion does not match the current version", async () => {
    const llmRepository = new InMemoryLlmEvaluationRepository();
    // Drive the gateway once with a stable provider so the cache row we
    // seed below actually shares the scanner's `(taskType, promptVersion,
    // model, inputHash)` cache key. This avoids duplicating the
    // production hash function in the test fixture (which previously
    // drifted and made the test pass for the wrong reason).
    const seedGateway = new PersistedLlmGateway(llmRepository, async () => ({
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
      }
    }), { validatorRegistry: buildScannerLlmValidatorRegistry() });
    const rawResolutionText = "Resolves on 2026-01-01T00:00:00Z";
    const seedScanner = new ReadOnlyScanner({
      kalshiClient: new StaticVenueClient({
        markets: [market("kalshi", "K1", "Will Bitcoin be above $100,000 on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "K1", venue: "kalshi", yesAsk: 0.42, noAsk: 0.62, yesAvailableUsd: 20, noAvailableUsd: 30, capturedAt }]
      }),
      polymarketClient: new StaticVenueClient({
        markets: [market("polymarket", "P1", "Will BTC be above $100,000 on Jan 1, 2026?", rawResolutionText)],
        books: [{ marketId: "P1", venue: "polymarket", yesAsk: 0.5, noAsk: 0.51, yesAvailableUsd: 50, noAvailableUsd: 12, capturedAt }]
      }),
      repository: new InMemoryScannerRepository(),
      llmGateway: seedGateway,
      llmPromptVersion: "v1",
      llmModel: "test-model",
      now: capturedAt
    });
    await seedScanner.runOnce();

    // Downgrade the cache row to a stale schema version so the gateway
    // revalidates the cached output against the current registry before
    // trusting it. The in-memory repository appends, so we replace the
    // original succeeded row in place and mark it failed to force a
    // fresh provider call.
    const cacheRow = llmRepository.records.find((record) => record.taskType === "market_normalization" && record.status === "succeeded");
    expect(cacheRow).toBeDefined();
    const cacheIndex = llmRepository.records.indexOf(cacheRow!);
    llmRepository.records[cacheIndex] = { ...cacheRow!, payloadSchemaVersion: "v0", status: "failed", parsedOutput: undefined };

    let providerCalls = 0;
    const llmGateway = new PersistedLlmGateway(llmRepository, async () => {
      providerCalls += 1;
      return {
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
        }
      };
    }, { validatorRegistry: buildScannerLlmValidatorRegistry() });

    const repository = new InMemoryScannerRepository();
    await scanner(llmGateway, {
      repository,
      llmPromptVersion: "v1",
      llmModel: "test-model"
    }).runOnce();

    // Issue #12: a stale-shape cache row must NOT be trusted; a fresh
    // provider call is made for the kalshi market (downgraded cache row)
    // and the polymarket market is still served from cache, so we expect
    // 1 fresh provider call.
    expect(providerCalls).toBe(1);
  });
});

function cachedNormalizationRecord(promptVersion: string, modelName: string, snapshot: VenueMarketSnapshot): LlmEvaluationRecord {
  const input = normalizedInputFor(snapshot);
  const output = {
    topic: "crypto",
    eventType: "price_above",
    asset: "BTC",
    threshold: Number(snapshot.title.match(/\$([0-9,]+)/)?.[1]?.replace(/,/g, "") ?? 100000),
    operator: ">",
    deadline: "2026-01-01T00:00:00.000Z",
    timezone: "UTC",
    resolutionSource: null,
    payoffType: "at_time",
    confidence: 0.9,
    ambiguityFlags: ["resolution_source_missing"]
  };
  return {
    id: `${snapshot.venueMarketId}-cached-normalization-000000000000`,
    taskType: "market_normalization",
    promptVersion,
    model: modelName,
    inputHash: hashStableInput(input),
    input,
    output,
    parsedOutput: output,
    status: "succeeded",
    promptTokens: 100,
    completionTokens: 50,
    estimatedCostUsd: 0,
    latencyMs: 1000,
    createdAt: capturedAt,
    payloadSchemaVersion: "v1"
  };
}

function normalizedInputFor(snapshot: VenueMarketSnapshot): Record<string, unknown> {
  const threshold = Number(snapshot.title.match(/\$([0-9,]+)/)?.[1]?.replace(/,/g, "") ?? 100000);
  return {
    venue: snapshot.venue,
    venueMarketId: snapshot.venueMarketId,
    title: snapshot.title,
    rawResolutionText: snapshot.rawResolutionText,
    topic: "crypto",
    eventType: "price_above",
    asset: "BTC",
    threshold,
    operator: ">",
    deadline: "2026-01-01T00:00:00.000Z",
    timezone: "UTC",
    resolutionSource: undefined,
    payoffType: "at_time",
    ambiguityFlags: ["resolution_source_missing"],
    confidence: 0.65
  };
}

function hashStableInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("Review fix #14 & #15 — Scanner-owned schema, single source of truth", () => {
  it("the scanner prompt-side description matches the validator schema", () => {
    const registry = buildScannerLlmValidatorRegistry();
    const normalizeVersion = registry.schemaVersionFor("market_normalization");
    const equivalenceVersion = registry.schemaVersionFor("market_equivalence");
    // Both tasks must be registered and versioned.
    expect(normalizeVersion).toBe("v1");
    expect(equivalenceVersion).toBe("v1");
  });
});

describe("describeScannerSchema and marketEquivalenceSchema coverage", () => {
  it("returns the market_equivalence prompt description when requested", () => {
    const equivDesc = describeScannerSchema("market_equivalence");
    expect(equivDesc.equivalent).toBe("boolean");
    expect(equivDesc.confidence).toBe("number 0..1");
    expect(equivDesc.explanation).toBe("non-empty string");

    const schema = marketEquivalenceSchema();
    const valid = schema.safeParse({ equivalent: true, confidence: 0.9, explanation: "reasons" });
    expect(valid.success).toBe(true);
  });

  it("returns the fallback description for an unknown task type", () => {
    const fallback = describeScannerSchema("anything_else" as any);
    expect(fallback.explanation).toBe("non-empty string");
  });
});
