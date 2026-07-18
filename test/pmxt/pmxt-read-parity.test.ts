import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { OpportunityCalculator } from "../../src/contexts/arbitrage/domain/opportunity-calculator";
import type { MarketBook } from "../../src/contexts/arbitrage/domain/opportunity";
import { InMemoryLlmEvaluationRepository } from "../../src/contexts/llm/application/in-memory-llm-evaluation-repository";
import type { LlmEvaluationRequest } from "../../src/contexts/llm/application/llm-evaluation";
import { PersistedLlmGateway } from "../../src/contexts/llm/application/persisted-llm-gateway";
import { CandidatePairGenerator } from "../../src/contexts/matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../../src/contexts/matching/domain/equivalence-policy";
import { MarketNormalizer } from "../../src/contexts/matching/domain/market-normalizer";
import {
  PmxtReadParityError,
  PmxtReadParityPipeline,
  buildPmxtShadowLlmRequest,
  canonicalizePmxtMarketBook,
  canonicalizePmxtMarketSnapshot,
  resolveOpportunityCalculatorOptions,
  type PmxtReadParityBatch,
  type PmxtReadParityProvenance,
} from "../../src/contexts/scanner/pmxt/pmxt-read-parity";
import { InMemoryPmxtReadParityRepository } from "../../src/contexts/scanner/pmxt/in-memory-pmxt-read-parity-repository";
import { PostgresPmxtReadParityRepository } from "../../src/contexts/scanner/pmxt/postgres-pmxt-read-parity-repository";
import {
  pmxtShadowCandidates,
  pmxtShadowComparisons,
  pmxtShadowOpportunities,
} from "../../src/db/schema";
import type { PmxtMarketSnapshot } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";
import type { PmxtMarketBook } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import type { VenueMarketSnapshot } from "../../src/contexts/venues/domain/venue-market";
import type { EquivalenceDecision } from "../../src/contexts/matching/domain/candidate-pair";

const CAPTURED_AT = "2026-12-31T23:59:30.000Z";
const COMPARED_AT = "2027-01-01T00:00:00.000Z";
const TITLE = "Will Bitcoin be above $100,000 on December 31, 2026?";
const RESOLUTION =
  "Resolves YES if the Coinbase BTC price is above $100,000 at 2026-12-31T23:59:59Z.";

const kalshiSnapshot: VenueMarketSnapshot = {
  venue: "kalshi",
  venueMarketId: "KXBTC-26DEC31-T100000",
  title: TITLE,
  rawResolutionText: RESOLUTION,
  capturedAt: CAPTURED_AT,
  rawPayload: { ticker: "KXBTC-26DEC31-T100000" },
};

const polymarketSnapshot: VenueMarketSnapshot = {
  venue: "polymarket",
  venueMarketId: "poly-btc-100k-2026",
  title: TITLE,
  rawResolutionText: RESOLUTION,
  capturedAt: CAPTURED_AT,
  rawPayload: { conditionId: "0xbtc100k" },
};

const kalshiBook: MarketBook = {
  marketId: kalshiSnapshot.venueMarketId,
  venue: "kalshi",
  yesAsk: 0.42,
  noAsk: 0.62,
  yesAvailableUsd: 42,
  noAvailableUsd: 62,
  yesDepth: [
    { price: 0.42, size: 100 },
    { price: 0.44, size: 50 },
  ],
  noDepth: [{ price: 0.62, size: 100 }],
  capturedAt: CAPTURED_AT,
  rawPayload: { ticker: kalshiSnapshot.venueMarketId },
};

const polymarketBook: MarketBook = {
  marketId: polymarketSnapshot.venueMarketId,
  venue: "polymarket",
  yesAsk: 0.5,
  noAsk: 0.51,
  yesAvailableUsd: 50,
  noAvailableUsd: 51,
  yesDepth: [{ price: 0.5, size: 100 }],
  noDepth: [
    { price: 0.51, size: 100 },
    { price: 0.53, size: 50 },
  ],
  capturedAt: CAPTURED_AT,
  rawPayload: { conditionId: "0xbtc100k" },
};

function pmxtSnapshotFor(
  native: VenueMarketSnapshot,
  catalogMarketId: string,
  yesOutcomeId: string,
  noOutcomeId: string,
): PmxtMarketSnapshot {
  return {
    venue: "pmxt",
    venueMarketId: catalogMarketId,
    title: native.title,
    rawResolutionText: native.rawResolutionText,
    capturedAt: native.capturedAt,
    rawPayload: {
      sourceExchange: native.venue,
      venueMarketId: native.venueMarketId,
      catalogMarketId,
      yesOutcomeId,
      noOutcomeId,
      sourcePayload: native.rawPayload,
      outcomes: [
        { id: yesOutcomeId, label: "Yes" },
        { id: noOutcomeId, label: "No" },
      ],
    },
  };
}

function pmxtBookFor(
  snapshot: PmxtMarketSnapshot,
  native: MarketBook,
  providerMetadata: Record<string, unknown> = {},
): PmxtMarketBook {
  return {
    marketId: snapshot.venueMarketId,
    venue: "pmxt",
    yesAsk: native.yesAsk,
    noAsk: native.noAsk,
    yesAvailableUsd: native.yesAvailableUsd,
    noAvailableUsd: native.noAvailableUsd,
    yesDepth: native.yesDepth ?? [],
    noDepth: native.noDepth ?? [],
    capturedAt: native.capturedAt,
    stale: native.stale ?? false,
    rawPayload: {
      sourcePayload: native.rawPayload ?? {},
      yesOutcomeId: snapshot.rawPayload.yesOutcomeId,
      noOutcomeId: snapshot.rawPayload.noOutcomeId,
      ...providerMetadata,
    },
  };
}

const pmxtKalshiSnapshot = pmxtSnapshotFor(
  kalshiSnapshot,
  "pmxt-kalshi-btc-100k",
  "pmxt-kalshi-yes",
  "pmxt-kalshi-no",
);
const pmxtPolymarketSnapshot = pmxtSnapshotFor(
  polymarketSnapshot,
  "pmxt-polymarket-btc-100k",
  "pmxt-polymarket-yes",
  "pmxt-polymarket-no",
);
const pmxtKalshiBook = pmxtBookFor(pmxtKalshiSnapshot, kalshiBook);
const pmxtPolymarketBook = pmxtBookFor(pmxtPolymarketSnapshot, polymarketBook, {
  // Provider-reported but unverified metadata is compared, not applied.
  feeSchedule: { rate: 0.07 },
});

function expectParityError(run: () => unknown, reasonCode: string): void {
  try {
    run();
    throw new Error("expected PMXT parity conversion to fail closed");
  } catch (error) {
    expect(error).toBeInstanceOf(PmxtReadParityError);
    expect(error).toMatchObject({ reasonCode });
  }
}

function isRecursivelyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isRecursivelyFrozen(child, seen));
}

function fakePool(): {
  pool: Pool;
  client: PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
} {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  } as unknown as PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    client,
  };
}

function callsContaining(
  client: { query: ReturnType<typeof vi.fn> },
  text: string,
): Array<{ sql: string; params: unknown[] }> {
  return client.query.mock.calls
    .filter(([sql]) => typeof sql === "string" && sql.toLowerCase().includes(text))
    .map(([sql, params]) => ({ sql: sql as string, params: (params ?? []) as unknown[] }));
}

describe("Issue #96 PMXT read parity acceptance contract", () => {
  describe("canonical PMXT adapter", () => {
    it("maps PMXT catalog identity to a native market while retaining complete PMXT provenance", () => {
      const canonical = canonicalizePmxtMarketSnapshot(pmxtPolymarketSnapshot);

      expect(canonical).toEqual({
        ...polymarketSnapshot,
        rawPayload: {
          ...polymarketSnapshot.rawPayload,
          pmxtProvenance: {
            catalogMarketId: "pmxt-polymarket-btc-100k",
            sourceExchange: "polymarket",
            venueMarketId: "poly-btc-100k-2026",
            yesOutcomeId: "pmxt-polymarket-yes",
            noOutcomeId: "pmxt-polymarket-no",
          },
        },
      });
    });

    it("maps a complete PMXT ask book to a native book without synthesizing prices", () => {
      const canonical = canonicalizePmxtMarketBook(pmxtPolymarketSnapshot, pmxtPolymarketBook);

      expect(canonical).toEqual({
        ...polymarketBook,
        stale: false,
        rawPayload: {
          ...polymarketBook.rawPayload,
          feeSchedule: { rate: 0.07 },
          pmxtProvenance: {
            catalogMarketId: "pmxt-polymarket-btc-100k",
            sourceExchange: "polymarket",
            venueMarketId: "poly-btc-100k-2026",
            yesOutcomeId: "pmxt-polymarket-yes",
            noOutcomeId: "pmxt-polymarket-no",
          },
        },
      });
    });

    it.each([
      ["missing_source_exchange", { sourceExchange: undefined }],
      ["ambiguous_source_exchange", { sourceExchange: "unknown-exchange" }],
      ["missing_venue_market_id", { venueMarketId: undefined }],
      ["ambiguous_market_identity", { venueMarketId: ["poly-a", "poly-b"] }],
    ])("fails closed with %s", (reasonCode, payloadPatch) => {
      expectParityError(
        () =>
          canonicalizePmxtMarketSnapshot({
            ...pmxtPolymarketSnapshot,
            rawPayload: { ...pmxtPolymarketSnapshot.rawPayload, ...payloadPatch },
          }),
        reasonCode,
      );
    });

    it.each(["YES", "NO"] as const)("rejects a %s-only book and never derives the missing ask", (presentSide) => {
      const oneSided: PmxtMarketBook = {
        ...pmxtPolymarketBook,
        yesAsk: presentSide === "YES" ? 0.5 : undefined,
        noAsk: presentSide === "NO" ? 0.51 : undefined,
        yesAvailableUsd: presentSide === "YES" ? 50 : 0,
        noAvailableUsd: presentSide === "NO" ? 51 : 0,
        yesDepth: presentSide === "YES" ? [{ price: 0.5, size: 100 }] : [],
        noDepth: presentSide === "NO" ? [{ price: 0.51, size: 100 }] : [],
        rawPayload: {
          ...pmxtPolymarketBook.rawPayload,
          bids: [{ price: presentSide === "YES" ? 0.49 : 0.48, size: 100 }],
        },
      };

      expectParityError(
        () => canonicalizePmxtMarketBook(pmxtPolymarketSnapshot, oneSided),
        "one_sided_book",
      );
    });
  });

  describe("shared calculator options and LLM request identity", () => {
    it("returns fully resolved readonly options that are recursively frozen and reusable by exact reference", () => {
      const resolved = resolveOpportunityCalculatorOptions({
        now: COMPARED_AT,
        feeSource: "config",
        targetNotionalsUsd: [25, 5, 25],
        venueFeeRates: { polymarket: { YES: 0.02 } },
        feeModels: {
          polymarket: {
            type: "polymarket",
            feeRateBps: 50,
            orderRole: "taker",
            version: "poly-fees-v1",
          },
        },
      });

      expect(resolved).toMatchObject({
        now: COMPARED_AT,
        feeSource: "config",
        targetNotionalsUsd: [5, 25],
        venueFeeRates: {
          kalshi: { YES: 0.01, NO: 0.01 },
          polymarket: { YES: 0.02, NO: 0.01 },
        },
        feeModels: { polymarket: { version: "poly-fees-v1" } },
        calculationVersion: "opportunity-calculator-v2",
        configVersion: "phase3-conservative-v1",
      });
      expect(isRecursivelyFrozen(resolved)).toBe(true);
    });

    it("preserves task, model, and the exact input reference while namespacing only the shadow prompt", () => {
      const productionRequest: LlmEvaluationRequest = {
        taskType: "market_equivalence",
        model: "scanner-model-v1",
        promptVersion: "scanner-equivalence-v3",
        input: { pairId: "pair-1", deterministicClass: "A" },
      };

      const shadowRequest = buildPmxtShadowLlmRequest(productionRequest);

      expect(shadowRequest).toEqual({
        ...productionRequest,
        promptVersion: "pmxt-shadow/scanner-equivalence-v3",
      });
      expect(shadowRequest.input).toBe(productionRequest.input);
    });

    it("uses an independent persisted-cache identity and never overwrites the production record", async () => {
      const repository = new InMemoryLlmEvaluationRepository();
      const provider = vi.fn().mockResolvedValue({
        output: { equivalent: true, confidence: 0.99, explanation: "same canonical market" },
      });
      const gateway = new PersistedLlmGateway(repository, provider);
      const productionRequest: LlmEvaluationRequest = {
        taskType: "market_equivalence",
        model: "scanner-model-v1",
        promptVersion: "scanner-equivalence-v3",
        input: { pairId: "pair-1", deterministicClass: "A" },
      };
      const shadowRequest = buildPmxtShadowLlmRequest(productionRequest);

      const productionRecord = await gateway.evaluate(productionRequest);
      const shadowRecord = await gateway.evaluate(shadowRequest);
      const productionCacheHit = await gateway.evaluate(productionRequest);

      expect(provider).toHaveBeenCalledTimes(2);
      expect(repository.records).toHaveLength(2);
      expect(repository.records[0]).toEqual(productionRecord);
      expect(productionRecord.parsedOutput).toEqual({
        equivalent: true,
        confidence: 0.99,
        explanation: "same canonical market",
      });
      expect(productionCacheHit).toMatchObject({ id: productionRecord.id, isCacheHit: true });
      expect(shadowRecord.id).not.toBe(productionRecord.id);
      expect(shadowRecord.inputHash).toBe(productionRecord.inputHash);
      expect(repository.records.map((record) => record.promptVersion)).toEqual([
        "scanner-equivalence-v3",
        "pmxt-shadow/scanner-equivalence-v3",
      ]);
    });
  });

  it("runs identical canonical inputs through every production stage, compares each closed outcome, and saves one shadow batch", async () => {
    const repository = new InMemoryPmxtReadParityRepository();
    const saveBatch = vi.spyOn(repository, "saveBatch");
    const calculator = new OpportunityCalculator();
    const calculate = vi.spyOn(calculator, "calculate");
    const llmRepository = new InMemoryLlmEvaluationRepository();
    const llmProvider = vi.fn().mockResolvedValue({
      output: { equivalent: true, confidence: 0.99, explanation: "same canonical market" },
    });
    const llmGateway = new PersistedLlmGateway(llmRepository, llmProvider);
    const productionLlmRequest: LlmEvaluationRequest = {
      taskType: "market_equivalence",
      model: "scanner-model-v1",
      promptVersion: "scanner-equivalence-v3",
      input: { pairId: "canonical-pair", deterministicClass: "A" },
    };
    const calculatorOptions = resolveOpportunityCalculatorOptions({
      now: COMPARED_AT,
      feeSource: "config",
      feeRate: 0.01,
      slippageRate: 0,
      targetNotionalsUsd: [5, 25],
    });
    const provenance: PmxtReadParityProvenance = {
      input: {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        authoritativeMarketIds: [kalshiSnapshot.venueMarketId, polymarketSnapshot.venueMarketId],
        pmxtCatalogMarketIds: [pmxtKalshiSnapshot.venueMarketId, pmxtPolymarketSnapshot.venueMarketId],
        pmxtOutcomeIds: [
          "pmxt-kalshi-yes",
          "pmxt-kalshi-no",
          "pmxt-polymarket-yes",
          "pmxt-polymarket-no",
        ],
      },
      provider: {
        authoritative: "native-venue-clients",
        shadow: "pmxt",
        sourceExchanges: ["kalshi", "polymarket"],
        llmModel: "scanner-model-v1",
      },
      timestamps: {
        authoritativeCapturedAt: CAPTURED_AT,
        shadowCapturedAt: CAPTURED_AT,
        comparedAt: COMPARED_AT,
      },
      config: {
        productionPromptVersion: "scanner-equivalence-v3",
        shadowPromptVersion: "pmxt-shadow/scanner-equivalence-v3",
        calculatorOptions,
      },
    };
    const pipeline = new PmxtReadParityPipeline({
      normalizer: new MarketNormalizer(),
      pairGenerator: new CandidatePairGenerator(),
      equivalencePolicy: new DeterministicEquivalencePolicy(),
      opportunityCalculator: calculator,
      llmGateway,
      buildProductionLlmRequest: () => productionLlmRequest,
      repository,
    });

    const result = await pipeline.run({
      authoritative: {
        markets: [kalshiSnapshot, polymarketSnapshot],
        books: [kalshiBook, polymarketBook],
      },
      pmxt: {
        markets: [pmxtKalshiSnapshot, pmxtPolymarketSnapshot],
        books: [pmxtKalshiBook, pmxtPolymarketBook],
      },
      calculatorOptions,
      provenance,
    });

    expect(result.shadow.canonicalMarkets).toEqual([
      expect.objectContaining({
        ...kalshiSnapshot,
        rawPayload: expect.objectContaining({
          pmxtProvenance: expect.objectContaining({
            catalogMarketId: pmxtKalshiSnapshot.venueMarketId,
            sourceExchange: "kalshi",
            venueMarketId: kalshiSnapshot.venueMarketId,
          }),
        }),
      }),
      expect.objectContaining({
        ...polymarketSnapshot,
        rawPayload: expect.objectContaining({
          pmxtProvenance: expect.objectContaining({
            catalogMarketId: pmxtPolymarketSnapshot.venueMarketId,
            sourceExchange: "polymarket",
            venueMarketId: polymarketSnapshot.venueMarketId,
          }),
        }),
      }),
    ]);
    expect(result.shadow.canonicalBooks).toEqual([
      expect.objectContaining({ marketId: kalshiBook.marketId, venue: "kalshi" }),
      expect.objectContaining({ marketId: polymarketBook.marketId, venue: "polymarket" }),
    ]);
    expect(result.authoritative.normalizedMarkets).toHaveLength(2);
    expect(result.authoritative.candidatePairs).toHaveLength(1);
    expect(result.authoritative.deterministicDecisions).toHaveLength(1);
    expect(result.authoritative.opportunities).toHaveLength(1);
    expect(result.shadow.normalizedMarkets).toEqual(result.authoritative.normalizedMarkets);
    expect(result.shadow.candidatePairs).toEqual(result.authoritative.candidatePairs);
    expect(result.shadow.deterministicDecisions).toEqual(result.authoritative.deterministicDecisions);
    expect(result.shadow.llmEvaluations.map((record) => record.parsedOutput)).toEqual(
      result.authoritative.llmEvaluations.map((record) => record.parsedOutput),
    );
    expect(result.shadow.opportunities).toEqual(result.authoritative.opportunities);

    expect(result.comparisons.map((comparison) => comparison.stage)).toEqual([
      "normalization",
      "pairing",
      "deterministic_equivalence",
      "llm_equivalence",
      "fees",
      "calculation",
      "depth",
      "executable_size",
      "risk",
    ]);
    for (const comparison of result.comparisons) {
      expect(comparison).toMatchObject({ outcome: "match", cause: expect.any(String) });
      expect(comparison.provenance).toEqual(provenance);
      expect(comparison.authoritative).toBeDefined();
      expect(comparison.shadow).toBeDefined();
    }
    for (const comparison of result.comparisons.filter(({ stage }) => stage !== "fees")) {
      expect(comparison.cause).toBe("identical");
    }
    expect(result.comparisons.find(({ stage }) => stage === "fees")).toMatchObject({
      outcome: "match",
      cause: "configured_fees_identical_unverified_metadata_ignored",
      authoritative: { feeSource: "config", providerMetadata: null },
      shadow: {
        feeSource: "config",
        providerMetadata: { feeSchedule: { rate: 0.07 } },
        metadataOutcome: "different",
        metadataCause: "unverified_provider_fee_metadata",
        verifiedProviderMetadataUsed: false,
      },
    });

    expect(calculate).toHaveBeenCalledTimes(2);
    expect(calculate.mock.calls[0]?.[4]).toBe(calculatorOptions);
    expect(calculate.mock.calls[1]?.[4]).toBe(calculatorOptions);
    expect(llmProvider).toHaveBeenCalledTimes(2);
    const [productionCall, shadowCall] = llmProvider.mock.calls.map(
      ([request]) => request as LlmEvaluationRequest,
    );
    expect(shadowCall).toEqual({
      ...productionCall,
      promptVersion: `pmxt-shadow/${productionCall.promptVersion}`,
    });
    expect(shadowCall.input).toBe(productionCall.input);

    expect(saveBatch).toHaveBeenCalledTimes(1);
    const persisted = repository.batches[0];
    expect(persisted).toEqual<PmxtReadParityBatch>({
      authoritativeScanRunId: provenance.input.authoritativeScanRunId,
      shadowRunId: provenance.input.shadowRunId,
      shadowRunAttemptId: provenance.input.shadowRunAttemptId,
      candidates: result.shadow.candidatePairs,
      candidateDecisions: result.shadow.deterministicDecisions,
      opportunities: result.shadow.opportunities,
      comparisons: result.comparisons,
    });
    expect(Object.keys(persisted)).not.toContain("authoritativeOpportunities");
  });

  describe("dedicated parity persistence", () => {
    it("persists one shadow-only batch atomically through the Postgres repository", async () => {
      const { pool, client } = fakePool();
      const repository = new PostgresPmxtReadParityRepository(pool);
      const normalizer = new MarketNormalizer();
      const [candidate] = new CandidatePairGenerator().generate([
        normalizer.normalize(kalshiSnapshot),
        normalizer.normalize(polymarketSnapshot),
      ]);
      const decision = new DeterministicEquivalencePolicy().classify(candidate);
      const calculatorOptions = resolveOpportunityCalculatorOptions({
        now: COMPARED_AT,
        feeSource: "config",
        slippageRate: 0,
        targetNotionalsUsd: [5],
      });
      const opportunities = new OpportunityCalculator().calculate(
        candidate,
        decision,
        kalshiBook,
        polymarketBook,
        calculatorOptions,
      );
      expect(opportunities).toHaveLength(1);
      const batch: PmxtReadParityBatch = {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        candidates: [candidate],
        candidateDecisions: [decision],
        opportunities,
        comparisons: [{
          stage: "fees",
          outcome: "match",
          cause: "configured_fees_identical_unverified_metadata_ignored",
          authoritative: { feeSource: "config", providerMetadata: null },
          shadow: {
            feeSource: "config",
            providerMetadata: { feeSchedule: { rate: 0.07 } },
            metadataOutcome: "different",
            metadataCause: "unverified_provider_fee_metadata",
            verifiedProviderMetadataUsed: false,
          },
          provenance: {
            input: {
              authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
              shadowRunId: "00000000-0000-4000-8000-000000009600",
              shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
              authoritativeMarketIds: [kalshiSnapshot.venueMarketId, polymarketSnapshot.venueMarketId],
              pmxtCatalogMarketIds: [pmxtKalshiSnapshot.venueMarketId, pmxtPolymarketSnapshot.venueMarketId],
              pmxtOutcomeIds: ["pmxt-kalshi-yes", "pmxt-kalshi-no", "pmxt-polymarket-yes", "pmxt-polymarket-no"],
            },
            provider: {
              authoritative: "native-venue-clients",
              shadow: "pmxt",
              sourceExchanges: ["kalshi", "polymarket"],
              llmModel: "scanner-model-v1",
            },
            timestamps: {
              authoritativeCapturedAt: CAPTURED_AT,
              shadowCapturedAt: CAPTURED_AT,
              comparedAt: COMPARED_AT,
            },
            config: {
              productionPromptVersion: "scanner-equivalence-v3",
              shadowPromptVersion: "pmxt-shadow/scanner-equivalence-v3",
              calculatorOptions,
            },
          },
        }],
      };

      await repository.saveBatch(batch);

      expect(client.query).toHaveBeenCalledWith("begin");
      expect(client.query).toHaveBeenCalledWith("commit");
      expect(client.query).not.toHaveBeenCalledWith("rollback");
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledWith();
      expect(callsContaining(client, "insert into pmxt_shadow_candidates")).toHaveLength(1);
      expect(callsContaining(client, "insert into pmxt_shadow_opportunities")).toHaveLength(1);
      expect(callsContaining(client, "insert into pmxt_shadow_comparisons")).toHaveLength(1);
      for (const { sql, params } of [
        ...callsContaining(client, "insert into pmxt_shadow_candidates"),
        ...callsContaining(client, "insert into pmxt_shadow_opportunities"),
        ...callsContaining(client, "insert into pmxt_shadow_comparisons"),
      ]) {
        expect(sql).toContain("authoritative_scan_run_id");
        expect(sql).toContain("shadow_run_id");
        expect(sql).toContain("shadow_run_attempt_id");
        expect(params).toEqual(expect.arrayContaining([
          batch.authoritativeScanRunId,
          batch.shadowRunId,
          batch.shadowRunAttemptId,
        ]));
      }
      expect(client.query.mock.calls.some(([sql]) =>
        typeof sql === "string" && /insert into (?:candidate_pairs|opportunities)\b/i.test(sql)
      )).toBe(false);
    });

    it("rolls back the whole Postgres batch when any dedicated insert fails", async () => {
      const { pool, client } = fakePool();
      client.query.mockImplementation(async (sql: string) => {
        if (sql.toLowerCase().includes("insert into pmxt_shadow_comparisons")) {
          throw new Error("comparison insert failed");
        }
        return { rows: [] };
      });
      const repository = new PostgresPmxtReadParityRepository(pool);
      const batch: PmxtReadParityBatch = {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        candidates: [],
        candidateDecisions: [],
        opportunities: [],
        comparisons: [{
          stage: "fees",
          outcome: "match",
          cause: "identical",
          authoritative: {},
          shadow: {},
          provenance: {} as PmxtReadParityProvenance,
        }],
      };

      await expect(repository.saveBatch(batch)).rejects.toThrow("comparison insert failed");

      expect(client.query).toHaveBeenCalledWith("begin");
      expect(client.query).toHaveBeenCalledWith("rollback");
      expect(client.query).not.toHaveBeenCalledWith("commit");
      expect(client.release).toHaveBeenCalledOnce();
      // Release is called without error when rollback succeeds
      expect(client.release).toHaveBeenCalledWith();
    });

    it("preserves the original error and releases with error when rollback itself fails", async () => {
      const { pool, client } = fakePool();
      const insertError = new Error("comparison insert failed");
      const rollbackError = new Error("rollback failed — connection broken");
      client.query.mockImplementation(async (sql: string) => {
        if (sql.toLowerCase().includes("insert into pmxt_shadow_comparisons")) {
          throw insertError;
        }
        if (sql.toLowerCase() === "rollback") {
          throw rollbackError;
        }
        return { rows: [] };
      });
      const repository = new PostgresPmxtReadParityRepository(pool);
      const batch: PmxtReadParityBatch = {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        candidates: [],
        candidateDecisions: [],
        opportunities: [],
        comparisons: [{
          stage: "fees",
          outcome: "match",
          cause: "identical",
          authoritative: {},
          shadow: {},
          provenance: {} as PmxtReadParityProvenance,
        }],
      };

      // The original error is preserved, not the rollback error
      await expect(repository.saveBatch(batch)).rejects.toThrow("comparison insert failed");

      expect(client.query).toHaveBeenCalledWith("begin");
      expect(client.query).toHaveBeenCalledWith("rollback");
      expect(client.query).not.toHaveBeenCalledWith("commit");
      // Release is called with the rollback error so pool evicts the broken connection
      expect(client.release).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledWith(rollbackError);
    });

    it("exports three dedicated Drizzle tables with safe scan and attempt linkage", () => {
      const tables = [pmxtShadowCandidates, pmxtShadowOpportunities, pmxtShadowComparisons];

      expect(tables.map((table) => getTableConfig(table).name)).toEqual([
        "pmxt_shadow_candidates",
        "pmxt_shadow_opportunities",
        "pmxt_shadow_comparisons",
      ]);
      for (const table of tables) {
        const config = getTableConfig(table);
        expect(table.authoritativeScanRunId).toMatchObject({
          name: "authoritative_scan_run_id",
          notNull: true,
        });
        expect(table.shadowRunId).toMatchObject({ name: "shadow_run_id", notNull: true });
        expect(table.shadowRunAttemptId).toMatchObject({
          name: "shadow_run_attempt_id",
          notNull: true,
        });
        const links = config.foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          return {
            columns: reference.columns.map((column) => column.name),
            foreignTable: getTableConfig(reference.foreignTable).name,
            foreignColumns: reference.foreignColumns.map((column) => column.name),
          };
        });
        expect(links).toEqual(expect.arrayContaining([
          {
            columns: ["authoritative_scan_run_id"],
            foreignTable: "scan_runs",
            foreignColumns: ["id"],
          },
          {
            columns: ["shadow_run_attempt_id"],
            foreignTable: "pmxt_shadow_run_attempts",
            foreignColumns: ["id"],
          },
        ]));
        expect(links).not.toContainEqual({
          columns: ["shadow_run_id"],
          foreignTable: "pmxt_shadow_run_attempts",
          foreignColumns: ["shadow_run_id"],
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Adversarial review findings (deepseek-v4-flash:cloud)
  // -------------------------------------------------------------------------

  describe("discrepancy detection and provenance", () => {
    it("flags a normalization discrepancy with an explicit cause and full provenance", async () => {
      const repository = new InMemoryPmxtReadParityRepository();
      const calculator = new OpportunityCalculator();
      const llmRepository = new InMemoryLlmEvaluationRepository();
      const llmProvider = vi.fn().mockResolvedValue({
        output: { equivalent: true, confidence: 0.99, explanation: "same canonical market" },
      });
      const llmGateway = new PersistedLlmGateway(llmRepository, llmProvider);
      const productionLlmRequest: LlmEvaluationRequest = {
        taskType: "market_equivalence",
        model: "scanner-model-v1",
        promptVersion: "scanner-equivalence-v3",
        input: { pairId: "canonical-pair", deterministicClass: "A" },
      };
      const calculatorOptions = resolveOpportunityCalculatorOptions({
        now: COMPARED_AT,
        feeSource: "config",
        feeRate: 0.01,
        slippageRate: 0,
        targetNotionalsUsd: [5, 25],
      });
      const provenance: PmxtReadParityProvenance = {
        input: {
          authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
          shadowRunId: "00000000-0000-4000-8000-000000009600",
          shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
          authoritativeMarketIds: [kalshiSnapshot.venueMarketId, polymarketSnapshot.venueMarketId],
          pmxtCatalogMarketIds: [pmxtKalshiSnapshot.venueMarketId, pmxtPolymarketSnapshot.venueMarketId],
          pmxtOutcomeIds: [
            "pmxt-kalshi-yes",
            "pmxt-kalshi-no",
            "pmxt-polymarket-yes",
            "pmxt-polymarket-no",
          ],
        },
        provider: {
          authoritative: "native-venue-clients",
          shadow: "pmxt",
          sourceExchanges: ["kalshi", "polymarket"],
          llmModel: "scanner-model-v1",
        },
        timestamps: {
          authoritativeCapturedAt: CAPTURED_AT,
          shadowCapturedAt: CAPTURED_AT,
          comparedAt: COMPARED_AT,
        },
        config: {
          productionPromptVersion: "scanner-equivalence-v3",
          shadowPromptVersion: "pmxt-shadow/scanner-equivalence-v3",
          calculatorOptions,
        },
      };

      // Shadow PMXT market has a DIFFERENT title from the authoritative one.
      const divergentPmxtKalshiSnapshot: PmxtMarketSnapshot = {
        ...pmxtKalshiSnapshot,
        title: "DIFFERENT TITLE — will cause normalization mismatch",
      };

      const pipeline = new PmxtReadParityPipeline({
        normalizer: new MarketNormalizer(),
        pairGenerator: new CandidatePairGenerator(),
        equivalencePolicy: new DeterministicEquivalencePolicy(),
        opportunityCalculator: calculator,
        llmGateway,
        buildProductionLlmRequest: () => productionLlmRequest,
        repository,
      });

      const result = await pipeline.run({
        authoritative: {
          markets: [kalshiSnapshot, polymarketSnapshot],
          books: [kalshiBook, polymarketBook],
        },
        pmxt: {
          markets: [divergentPmxtKalshiSnapshot, pmxtPolymarketSnapshot],
          books: [pmxtKalshiBook, pmxtPolymarketBook],
        },
        calculatorOptions,
        provenance,
      });

      const normalizationComparison = result.comparisons.find(
        (c) => c.stage === "normalization",
      );
      expect(normalizationComparison).toBeDefined();
      expect(normalizationComparison!.outcome).toBe("discrepancy");
      expect(normalizationComparison!.cause).toBe("normalization_output_differs");
      expect(normalizationComparison!.provenance).toEqual(provenance);
      expect(normalizationComparison!.authoritative).toBeDefined();
      expect(normalizationComparison!.shadow).toBeDefined();
    });
  });

  describe("comparison insert idempotency", () => {
    it("uses ON CONFLICT DO NOTHING for comparisons so retried batches do not duplicate rows", async () => {
      const { pool, client } = fakePool();
      const repository = new PostgresPmxtReadParityRepository(pool);
      const batch: PmxtReadParityBatch = {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        candidates: [],
        opportunities: [],
        candidateDecisions: [],
        comparisons: [{
          stage: "normalization",
          outcome: "match",
          cause: "identical",
          authoritative: {},
          shadow: {},
          provenance: {} as PmxtReadParityProvenance,
        }],
      };

      await repository.saveBatch(batch);

      const comparisonCalls = callsContaining(client, "insert into pmxt_shadow_comparisons");
      expect(comparisonCalls).toHaveLength(1);
      expect(comparisonCalls[0].sql.toLowerCase()).toContain("on conflict");
      expect(comparisonCalls[0].sql.toLowerCase()).toContain("do nothing");
    });
  });

  describe("candidate decision persistence", () => {
    it("populates equivalence_class and decision columns from the batch's candidateDecisions", async () => {
      const { pool, client } = fakePool();
      const repository = new PostgresPmxtReadParityRepository(pool);
      const normalizer = new MarketNormalizer();
      const [candidate] = new CandidatePairGenerator().generate([
        normalizer.normalize(kalshiSnapshot),
        normalizer.normalize(polymarketSnapshot),
      ]);
      const decision: EquivalenceDecision = new DeterministicEquivalencePolicy().classify(candidate);
      const batch: PmxtReadParityBatch = {
        authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
        shadowRunId: "00000000-0000-4000-8000-000000009600",
        shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
        candidates: [candidate],
        candidateDecisions: [decision],
        opportunities: [],
        comparisons: [],
      };

      await repository.saveBatch(batch);

      const candidateCalls = callsContaining(client, "insert into pmxt_shadow_candidates");
      expect(candidateCalls).toHaveLength(1);
      // equivalence_class (param $7) and decision (param $8) must be populated
      expect(candidateCalls[0].params[6]).toBe(decision.equivalenceClass);
      expect(candidateCalls[0].params[7]).toBe(decision.decision);
    });

    it("includes candidateDecisions in the batch saved by the pipeline", async () => {
      const repository = new InMemoryPmxtReadParityRepository();
      const calculator = new OpportunityCalculator();
      const llmRepository = new InMemoryLlmEvaluationRepository();
      const llmProvider = vi.fn().mockResolvedValue({
        output: { equivalent: true, confidence: 0.99, explanation: "same canonical market" },
      });
      const llmGateway = new PersistedLlmGateway(llmRepository, llmProvider);
      const productionLlmRequest: LlmEvaluationRequest = {
        taskType: "market_equivalence",
        model: "scanner-model-v1",
        promptVersion: "scanner-equivalence-v3",
        input: { pairId: "canonical-pair", deterministicClass: "A" },
      };
      const calculatorOptions = resolveOpportunityCalculatorOptions({
        now: COMPARED_AT,
        feeSource: "config",
        feeRate: 0.01,
        slippageRate: 0,
        targetNotionalsUsd: [5, 25],
      });
      const provenance: PmxtReadParityProvenance = {
        input: {
          authoritativeScanRunId: "00000000-0000-4000-8000-000000000096",
          shadowRunId: "00000000-0000-4000-8000-000000009600",
          shadowRunAttemptId: "00000000-0000-4000-8000-000000009601",
          authoritativeMarketIds: [kalshiSnapshot.venueMarketId, polymarketSnapshot.venueMarketId],
          pmxtCatalogMarketIds: [pmxtKalshiSnapshot.venueMarketId, pmxtPolymarketSnapshot.venueMarketId],
          pmxtOutcomeIds: [
            "pmxt-kalshi-yes", "pmxt-kalshi-no", "pmxt-polymarket-yes", "pmxt-polymarket-no",
          ],
        },
        provider: {
          authoritative: "native-venue-clients",
          shadow: "pmxt",
          sourceExchanges: ["kalshi", "polymarket"],
          llmModel: "scanner-model-v1",
        },
        timestamps: {
          authoritativeCapturedAt: CAPTURED_AT,
          shadowCapturedAt: CAPTURED_AT,
          comparedAt: COMPARED_AT,
        },
        config: {
          productionPromptVersion: "scanner-equivalence-v3",
          shadowPromptVersion: "pmxt-shadow/scanner-equivalence-v3",
          calculatorOptions,
        },
      };

      const pipeline = new PmxtReadParityPipeline({
        normalizer: new MarketNormalizer(),
        pairGenerator: new CandidatePairGenerator(),
        equivalencePolicy: new DeterministicEquivalencePolicy(),
        opportunityCalculator: calculator,
        llmGateway,
        buildProductionLlmRequest: () => productionLlmRequest,
        repository,
      });

      await pipeline.run({
        authoritative: {
          markets: [kalshiSnapshot, polymarketSnapshot],
          books: [kalshiBook, polymarketBook],
        },
        pmxt: {
          markets: [pmxtKalshiSnapshot, pmxtPolymarketSnapshot],
          books: [pmxtKalshiBook, pmxtPolymarketBook],
        },
        calculatorOptions,
        provenance,
      });

      const persisted = repository.batches[0];
      expect(persisted.candidateDecisions).toHaveLength(1);
      expect(persisted.candidateDecisions[0].pairId).toBe(persisted.candidates[0].id);
    });
  });

  it("keeps parity production modules structurally isolated from production persistence and side effects", () => {
    const intendedModules = [
      "src/contexts/scanner/pmxt/pmxt-read-parity.ts",
      "src/contexts/scanner/pmxt/in-memory-pmxt-read-parity-repository.ts",
      "src/contexts/scanner/pmxt/postgres-pmxt-read-parity-repository.ts",
    ];
    const forbiddenImports = [
      /(?:from|import\()[^\n]*(?:scanner-repository|postgres-scanner-repository)/,
      /(?:from|import\()[^\n]*alerts?/,
      /(?:from|import\()[^\n]*execution/,
      /(?:from|import\()[^\n]*positions?/,
      /(?:from|import\()[^\n]*(?:api-app|main-api)/,
    ];

    for (const relativePath of intendedModules) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      for (const forbidden of forbiddenImports) {
        expect(source, `${relativePath} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});
