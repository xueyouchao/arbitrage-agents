import { describe, expect, it } from "vitest";
import {
  comparePmxtCoverage,
  PmxtCoverageComparisonInput,
} from "../../src/contexts/scanner/pmxt/pmxt-coverage-comparator";
import { PmxtMarketSnapshot } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";
import { VenueMarketSnapshot } from "../../src/contexts/venues/domain/venue-market";

const capturedAt = "2026-07-15T12:00:00.000Z";

function pmxtSnapshot(
  pmxtId: string,
  sourceExchange: string,
  venueMarketId: string,
  overrides: Partial<PmxtMarketSnapshot> = {}
): PmxtMarketSnapshot {
  return {
    venue: "pmxt",
    venueMarketId: pmxtId,
    title: `PMXT market ${pmxtId}`,
    rawResolutionText: "Resolves per official source.",
    capturedAt,
    rawPayload: {
      id: pmxtId,
      sourceExchange,
      venueMarketId,
      yesOutcomeId: "yes-1",
      noOutcomeId: "no-1",
      ...overrides.rawPayload,
    },
    ...overrides,
  };
}

function kalshiSnapshot(
  marketId: string,
  overrides: Partial<VenueMarketSnapshot> = {}
): VenueMarketSnapshot {
  return {
    venue: "kalshi",
    venueMarketId: marketId,
    title: `Kalshi market ${marketId}`,
    rawResolutionText: "Resolves per official source.",
    rawPayload: { ticker: marketId },
    capturedAt,
    ...overrides,
  };
}

function polymarketSnapshot(
  marketId: string,
  overrides: Partial<VenueMarketSnapshot> = {}
): VenueMarketSnapshot {
  return {
    venue: "polymarket",
    venueMarketId: marketId,
    title: `Polymarket market ${marketId}`,
    rawResolutionText: "Resolves per official source.",
    rawPayload: { slug: marketId },
    capturedAt,
    ...overrides,
  };
}

describe("PMXT coverage comparator", () => {
  // -----------------------------------------------------------------------
  // Catalog UUID vs venue-native ID
  // -----------------------------------------------------------------------
  it("maps PMXT catalog UUID to venue-native Kalshi ID", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-uuid-1", "kalshi", "KXBTCD-25JUL26")],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.kalshi.authoritativeOnlyIds).toEqual([]);
    expect(result.kalshi.pmxtOnlyIds).toEqual([]);
    expect(result.mappingFailures).toHaveLength(0);
  });

  it("maps PMXT catalog UUID to venue-native Polymarket ID", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-uuid-2", "polymarket", "btc-above-100k")],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [polymarketSnapshot("btc-above-100k")],
    };
    const result = comparePmxtCoverage(input);
    expect(result.polymarket.overlapCount).toBe(1);
    expect(result.polymarket.authoritativeOnlyIds).toEqual([]);
    expect(result.polymarket.pmxtOnlyIds).toEqual([]);
    expect(result.mappingFailures).toHaveLength(0);
  });

  it("detects authoritative-only markets not in PMXT catalog", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-uuid-1", "kalshi", "KXBTCD-25JUL26")],
      authoritativeKalshiMarkets: [
        kalshiSnapshot("KXBTCD-25JUL26"),
        kalshiSnapshot("KXBTCD-01AUG26"),
      ],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.kalshi.authoritativeOnlyIds).toEqual(["kxbtcd-01aug26"]);
    expect(result.kalshi.pmxtOnlyIds).toEqual([]);
  });

  it("detects PMXT-only markets not in authoritative scan", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-uuid-1", "kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-uuid-2", "kalshi", "KXBTCD-01AUG26"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.kalshi.authoritativeOnlyIds).toEqual([]);
    expect(result.kalshi.pmxtOnlyIds).toEqual(["kxbtcd-01aug26"]);
  });

  // -----------------------------------------------------------------------
  // Ambiguous source exchange
  // -----------------------------------------------------------------------
  it("excludes PMXT markets with missing sourceExchange", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          venue: "pmxt",
          venueMarketId: "pmxt-no-source",
          title: "No source",
          rawResolutionText: "",
          capturedAt,
          rawPayload: { id: "pmxt-no-source", yesOutcomeId: "y", noOutcomeId: "n" },
        },
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-no-source",
      reasonCode: "ambiguous_source_exchange",
    });
  });

  it("excludes PMXT markets with unrecognized sourceExchange", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-unknown", "betfair", "bf-123")],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-unknown",
      reasonCode: "unrecognized_source_exchange",
    });
  });

  it("excludes PMXT markets with empty sourceExchange string", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-empty-src", "", "some-id")],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0].reasonCode).toBe("ambiguous_source_exchange");
  });

  // -----------------------------------------------------------------------
  // Missing venue-native ID
  // -----------------------------------------------------------------------
  it("excludes PMXT markets with missing venue-native ID", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          venue: "pmxt",
          venueMarketId: "pmxt-no-native",
          title: "No native ID",
          rawResolutionText: "",
          capturedAt,
          rawPayload: {
            id: "pmxt-no-native",
            sourceExchange: "kalshi",
            yesOutcomeId: "y",
            noOutcomeId: "n",
          },
        },
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-no-native",
      reasonCode: "missing_venue_native_id",
    });
  });

  // -----------------------------------------------------------------------
  // Duplicate native identity
  // -----------------------------------------------------------------------
  it("detects duplicate venue-native IDs in PMXT catalog", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-uuid-1", "kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-uuid-2", "kalshi", "KXBTCD-25JUL26"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.duplicateNativeIds).toHaveLength(1);
    expect(result.kalshi.duplicateNativeIds[0]).toMatchObject({
      venueNativeId: "kxbtcd-25jul26",
      pmxtMarketIds: ["pmxt-uuid-1", "pmxt-uuid-2"],
    });
    // Overlap still counts once
    expect(result.kalshi.overlapCount).toBe(1);
  });

  it("detects duplicate native IDs across different source exchanges", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-uuid-1", "kalshi", "shared-id"),
        pmxtSnapshot("pmxt-uuid-2", "polymarket", "shared-id"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("shared-id")],
      authoritativePolymarketMarkets: [polymarketSnapshot("shared-id")],
    };
    const result = comparePmxtCoverage(input);
    // Each venue independently has the native ID
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.polymarket.overlapCount).toBe(1);
    // No duplicate within a single venue
    expect(result.kalshi.duplicateNativeIds).toHaveLength(0);
    expect(result.polymarket.duplicateNativeIds).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Status disagreement
  // -----------------------------------------------------------------------
  it("detects status disagreement when PMXT market has a status field", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-closed", "kalshi", "KXBTCD-25JUL26", {
          rawPayload: {
            id: "pmxt-closed",
            sourceExchange: "kalshi",
            venueMarketId: "KXBTCD-25JUL26",
            status: "closed",
            yesOutcomeId: "y",
            noOutcomeId: "n",
          },
        }),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    // The authoritative scan only fetches open markets, so a closed PMXT market
    // overlapping with an authoritative open market is a status disagreement.
    expect(result.kalshi.statusDisagreements).toHaveLength(1);
    expect(result.kalshi.statusDisagreements[0]).toMatchObject({
      venueNativeId: "kxbtcd-25jul26",
      pmxtStatus: "closed",
    });
  });

  it("does not flag status disagreement when PMXT status is open", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-open", "kalshi", "KXBTCD-25JUL26", {
          rawPayload: {
            id: "pmxt-open",
            sourceExchange: "kalshi",
            venueMarketId: "KXBTCD-25JUL26",
            status: "open",
            yesOutcomeId: "y",
            noOutcomeId: "n",
          },
        }),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.statusDisagreements).toHaveLength(0);
  });

  it("does not flag status disagreement when PMXT has no status field", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-no-status", "kalshi", "KXBTCD-25JUL26")],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.statusDisagreements).toHaveLength(0);
  });

  it("deduplicates status disagreements from duplicate PMXT records", () => {
    // Two PMXT records map to the same native ID, both with status "closed".
    // Only one status disagreement should be reported.
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-dupe-1", "kalshi", "KXBTCD-25JUL26", {
          rawPayload: {
            id: "pmxt-dupe-1",
            sourceExchange: "kalshi",
            venueMarketId: "KXBTCD-25JUL26",
            status: "closed",
            yesOutcomeId: "y",
            noOutcomeId: "n",
          },
        }),
        pmxtSnapshot("pmxt-dupe-2", "kalshi", "KXBTCD-25JUL26", {
          rawPayload: {
            id: "pmxt-dupe-2",
            sourceExchange: "kalshi",
            venueMarketId: "KXBTCD-25JUL26",
            status: "closed",
            yesOutcomeId: "y",
            noOutcomeId: "n",
          },
        }),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.statusDisagreements).toHaveLength(1);
    expect(result.kalshi.statusDisagreements[0]).toMatchObject({
      venueNativeId: "kxbtcd-25jul26",
      pmxtStatus: "closed",
    });
  });

  it("deduplicates missing resolution text from duplicate PMXT records", () => {
    // Two PMXT records map to the same native ID, both missing resolution text.
    // Only one entry should appear in missingResolutionText.
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-nores-1", "kalshi", "KXBTCD-25JUL26", {
          rawResolutionText: "",
        }),
        pmxtSnapshot("pmxt-nores-2", "kalshi", "KXBTCD-25JUL26", {
          rawResolutionText: "",
        }),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.missingResolutionText).toHaveLength(1);
    expect(result.kalshi.missingResolutionText).toContain("kxbtcd-25jul26");
  });

  // -----------------------------------------------------------------------
  // Missing resolution text
  // -----------------------------------------------------------------------
  it("flags PMXT markets with missing resolution text", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-no-res", "kalshi", "KXBTCD-25JUL26", {
          rawResolutionText: "",
        }),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.missingResolutionText).toContain("kxbtcd-25jul26");
  });

  it("does not flag resolution text when present", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-has-res", "kalshi", "KXBTCD-25JUL26")],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.missingResolutionText).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Coverage denominator scoping
  // -----------------------------------------------------------------------
  it("uses authoritative market count as coverage denominator", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-1", "kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-2", "kalshi", "KXBTCD-01AUG26"),
        pmxtSnapshot("pmxt-3", "kalshi", "KXBTCD-08AUG26"),
      ],
      authoritativeKalshiMarkets: [
        kalshiSnapshot("KXBTCD-25JUL26"),
        kalshiSnapshot("KXBTCD-01AUG26"),
      ],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.authoritativeCount).toBe(2);
    expect(result.kalshi.pmxtMappedCount).toBe(3);
    expect(result.kalshi.overlapCount).toBe(2);
  });

  it("does not include unrelated global catalog records in coverage denominator", () => {
    // PMXT returns a global catalog with sports/politics markets, but the
    // authoritative scan is scoped to crypto series only. The comparator
    // must not inflate the denominator with non-crypto PMXT records.
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-crypto-1", "kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-sports", "kalshi", "nba-finals-winner"),
        pmxtSnapshot("pmxt-politics", "kalshi", "election-2024"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    // Denominator is authoritative count (1), not PMXT global count (3)
    expect(result.kalshi.authoritativeCount).toBe(1);
    // PMXT-only includes the sports/politics markets that aren't in authoritative
    expect(result.kalshi.pmxtOnlyIds).toEqual(
      expect.arrayContaining(["nba-finals-winner", "election-2024"])
    );
  });

  // -----------------------------------------------------------------------
  // Mapping failures and excluded records remain visible
  // -----------------------------------------------------------------------
  it("reports all mapping failures without silently dropping any", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-ok", "kalshi", "KXBTCD-25JUL26"),
        {
          venue: "pmxt",
          venueMarketId: "pmxt-bad-1",
          title: "Bad 1",
          rawResolutionText: "",
          capturedAt,
          rawPayload: { id: "pmxt-bad-1", yesOutcomeId: "y", noOutcomeId: "n" },
        },
        pmxtSnapshot("pmxt-bad-2", "unknown-venue", "some-id"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(2);
    expect(result.mappingFailures.map((f) => f.pmxtMarketId).sort()).toEqual([
      "pmxt-bad-1",
      "pmxt-bad-2",
    ]);
    // The good record is still counted
    expect(result.kalshi.overlapCount).toBe(1);
  });

  it("reports mapping failures with reason codes", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-excluded", "betfair", "bf-123"),
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-excluded",
      reasonCode: "unrecognized_source_exchange",
    });
  });

  // -----------------------------------------------------------------------
  // Comparisons use authoritative receipt capturedAt
  // -----------------------------------------------------------------------
  it("uses authoritative capturedAt for comparison timestamps", () => {
    const authCapturedAt = "2026-07-15T12:00:00.000Z";
    const pmxtCapturedAt = "2026-07-15T12:00:05.000Z";
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          ...pmxtSnapshot("pmxt-1", "kalshi", "KXBTCD-25JUL26"),
          capturedAt: pmxtCapturedAt,
        },
      ],
      authoritativeKalshiMarkets: [
        { ...kalshiSnapshot("KXBTCD-25JUL26"), capturedAt: authCapturedAt },
      ],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    // The comparison should record both timestamps
    expect(result.comparisonTimestamp).toBe(authCapturedAt);
    expect(result.pmxtComparisonTimestamp).toBe(pmxtCapturedAt);
  });

  // -----------------------------------------------------------------------
  // Empty inputs
  // -----------------------------------------------------------------------
  it("handles empty PMXT markets gracefully", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [polymarketSnapshot("btc-above-100k")],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.authoritativeCount).toBe(1);
    expect(result.kalshi.pmxtMappedCount).toBe(0);
    expect(result.kalshi.overlapCount).toBe(0);
    expect(result.kalshi.authoritativeOnlyIds).toEqual(["kxbtcd-25jul26"]);
    expect(result.polymarket.authoritativeCount).toBe(1);
    expect(result.polymarket.pmxtMappedCount).toBe(0);
    expect(result.polymarket.overlapCount).toBe(0);
    expect(result.mappingFailures).toHaveLength(0);
  });

  it("handles empty authoritative markets gracefully", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [pmxtSnapshot("pmxt-1", "kalshi", "KXBTCD-25JUL26")],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.authoritativeCount).toBe(0);
    expect(result.kalshi.pmxtMappedCount).toBe(1);
    expect(result.kalshi.overlapCount).toBe(0);
    expect(result.kalshi.pmxtOnlyIds).toEqual(["kxbtcd-25jul26"]);
  });

  // -----------------------------------------------------------------------
  // Both venues simultaneously
  // -----------------------------------------------------------------------
  it("compares both Kalshi and Polymarket coverage in one pass", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-k-1", "kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-k-2", "kalshi", "KXBTCD-01AUG26"),
        pmxtSnapshot("pmxt-p-1", "polymarket", "btc-above-100k"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [polymarketSnapshot("btc-above-100k")],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.authoritativeCount).toBe(1);
    expect(result.kalshi.pmxtMappedCount).toBe(2);
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.kalshi.pmxtOnlyIds).toEqual(["kxbtcd-01aug26"]);
    expect(result.polymarket.authoritativeCount).toBe(1);
    expect(result.polymarket.pmxtMappedCount).toBe(1);
    expect(result.polymarket.overlapCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Malformed rawPayload guards
  // -----------------------------------------------------------------------
  it("handles null rawPayload without crashing", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          venue: "pmxt",
          venueMarketId: "pmxt-null-payload",
          title: "Null payload",
          rawResolutionText: "",
          capturedAt,
          rawPayload: null as unknown as Record<string, unknown>,
        },
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-null-payload",
      reasonCode: "missing_raw_payload",
    });
  });

  it("handles undefined rawPayload without crashing", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          venue: "pmxt",
          venueMarketId: "pmxt-undef-payload",
          title: "Undefined payload",
          rawResolutionText: "",
          capturedAt,
          rawPayload: undefined as unknown as Record<string, unknown>,
        },
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-undef-payload",
      reasonCode: "missing_raw_payload",
    });
  });

  it("handles non-object rawPayload (string) without crashing", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        {
          venue: "pmxt",
          venueMarketId: "pmxt-string-payload",
          title: "String payload",
          rawResolutionText: "",
          capturedAt,
          rawPayload: "malformed" as unknown as Record<string, unknown>,
        },
      ],
      authoritativeKalshiMarkets: [],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    expect(result.mappingFailures).toHaveLength(1);
    expect(result.mappingFailures[0]).toMatchObject({
      pmxtMarketId: "pmxt-string-payload",
      reasonCode: "missing_raw_payload",
    });
  });

  // -----------------------------------------------------------------------
  // Case-insensitive source exchange matching
  // -----------------------------------------------------------------------
  it("matches sourceExchange case-insensitively", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-1", "Kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-2", "POLYMARKET", "btc-above-100k"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [polymarketSnapshot("btc-above-100k")],
    };
    const result = comparePmxtCoverage(input);
    expect(result.kalshi.overlapCount).toBe(1);
    expect(result.polymarket.overlapCount).toBe(1);
    expect(result.mappingFailures).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Listing/closure lag — market listed on PMXT but not yet on venue
  // -----------------------------------------------------------------------
  it("detects PMXT markets not yet listed on the venue (listing lag)", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-1", "Kalshi", "KXBTCD-25JUL26"),
        pmxtSnapshot("pmxt-2", "Kalshi", "KXBTCD-25AUG26"),
      ],
      authoritativeKalshiMarkets: [kalshiSnapshot("KXBTCD-25JUL26")],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    // pmxt-2 is in PMXT but not in authoritative Kalshi → PMXT-only
    expect(result.kalshi.pmxtOnlyIds).toHaveLength(1);
    expect(result.kalshi.overlapCount).toBe(1);
  });

  it("detects venue markets not yet listed on PMXT (closure lag)", () => {
    const input: PmxtCoverageComparisonInput = {
      pmxtMarkets: [
        pmxtSnapshot("pmxt-1", "Kalshi", "KXBTCD-25JUL26"),
      ],
      authoritativeKalshiMarkets: [
        kalshiSnapshot("KXBTCD-25JUL26"),
        kalshiSnapshot("KXBTCD-25AUG26"),
      ],
      authoritativePolymarketMarkets: [],
    };
    const result = comparePmxtCoverage(input);
    // KXBTCD-25AUG26 is in authoritative but not in PMXT → authoritative-only
    expect(result.kalshi.authoritativeOnlyIds).toHaveLength(1);
    expect(result.kalshi.overlapCount).toBe(1);
  });
});
