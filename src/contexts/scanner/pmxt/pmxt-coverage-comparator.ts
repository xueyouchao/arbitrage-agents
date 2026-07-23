// PMXT Coverage Comparator.
//
// For each shadow run, maps PMXT catalog records to stable venue-native
// Kalshi/Polymarket identity, scopes them exactly like the authoritative
// crypto scan, compares coverage and material fields, and persists
// eligibility-aware, reason-coded differences without touching production
// read models.
//
// Key behaviors:
//   - Maps PMXT catalog UUIDs to venue-native IDs via sourceExchange and
//     venueMarketId in rawPayload.
//   - Excludes records with missing/ambiguous source exchange or missing
//     venue-native ID; these are reported as mapping failures.
//   - Detects duplicate native IDs within a venue.
//   - Detects status disagreements (PMXT closed vs authoritative open).
//   - Flags missing resolution text.
//   - Uses authoritative receipt capturedAt for comparison timestamps.
//   - Coverage denominators are equivalent to configured Kalshi series and
//     Polymarket series scopes (the authoritative market lists).

import { PmxtMarketSnapshot } from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PmxtCoverageComparisonInput {
  pmxtMarkets: PmxtMarketSnapshot[];
  authoritativeKalshiMarkets: VenueMarketSnapshot[];
  authoritativePolymarketMarkets: VenueMarketSnapshot[];
}

export interface PmxtCoverageComparisonResult {
  kalshi: VenueCoverageResult;
  polymarket: VenueCoverageResult;
  mappingFailures: MappingFailure[];
  comparisonTimestamp: string;
  pmxtComparisonTimestamp: string;
}

export interface PmxtCoverageScope {
  kind: "series";
  values: string[];
}

export interface EquivalentScopeCoverageInput extends PmxtCoverageComparisonInput {
  scope: {
    authoritative: PmxtCoverageScope;
    pmxt: PmxtCoverageScope;
  };
  pmxtScopedNativeIds?: {
    kalshi: string[];
    polymarket: string[];
  };
}

export type EquivalentScopeCoverageResult =
  | {
      outcome: "excluded";
      cause: "scope_mismatch" | "scope_unproven";
      scope: EquivalentScopeCoverageInput["scope"];
      coverage?: undefined;
      excludedPmxtMarketIds: string[];
    }
  | {
      outcome: "compared";
      cause: "scope_equivalent";
      scope: EquivalentScopeCoverageInput["scope"];
      coverage: PmxtCoverageComparisonResult;
      excludedPmxtMarketIds: string[];
    };

export interface VenueCoverageResult {
  authoritativeCount: number;
  pmxtMappedCount: number;
  overlapCount: number;
  authoritativeOnlyIds: string[];
  pmxtOnlyIds: string[];
  duplicateNativeIds: DuplicateNativeId[];
  statusDisagreements: StatusDisagreement[];
  missingResolutionText: string[];
}

export interface MappingFailure {
  pmxtMarketId: string;
  reasonCode: string;
  reason: string;
}

export interface DuplicateNativeId {
  venueNativeId: string;
  pmxtMarketIds: string[];
}

export interface StatusDisagreement {
  venueNativeId: string;
  pmxtStatus: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MappedPmxtRecord {
  pmxtMarketId: string;
  venue: "kalshi" | "polymarket";
  venueNativeId: string;
  status?: string;
  hasResolutionText: boolean;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

export function comparePmxtCoverage(
  input: PmxtCoverageComparisonInput
): PmxtCoverageComparisonResult {
  const mappingFailures: MappingFailure[] = [];
  const mappedRecords: MappedPmxtRecord[] = [];

  // Determine comparison timestamps from the authoritative side (earliest
  // capturedAt across both venues) and the PMXT side.
  const authTimestamps = [
    ...input.authoritativeKalshiMarkets.map((m) => m.capturedAt),
    ...input.authoritativePolymarketMarkets.map((m) => m.capturedAt),
  ].filter(Boolean);
  const pmxtTimestamps = input.pmxtMarkets.map((m) => m.capturedAt).filter(Boolean);

  const comparisonTimestamp =
    authTimestamps.length > 0
      ? authTimestamps.sort()[0]
      : new Date().toISOString();
  const pmxtComparisonTimestamp =
    pmxtTimestamps.length > 0
      ? pmxtTimestamps.sort()[0]
      : new Date().toISOString();

  // Map each PMXT market to a venue-native record or record a failure.
  for (const pmxtMarket of input.pmxtMarkets) {
    const result = tryMapPmxtToVenue(pmxtMarket);
    if (result.kind === "failure") {
      mappingFailures.push(result.failure);
      continue;
    }
    mappedRecords.push(result.record);
  }

  // Compute per-venue coverage.
  const kalshiResult = computeVenueCoverage(
    mappedRecords.filter((r) => r.venue === "kalshi"),
    input.authoritativeKalshiMarkets
  );
  const polymarketResult = computeVenueCoverage(
    mappedRecords.filter((r) => r.venue === "polymarket"),
    input.authoritativePolymarketMarkets
  );

  return {
    kalshi: kalshiResult,
    polymarket: polymarketResult,
    mappingFailures,
    comparisonTimestamp,
    pmxtComparisonTimestamp,
  };
}

export function comparePmxtCoverageWithinEquivalentScope(
  input: EquivalentScopeCoverageInput
): EquivalentScopeCoverageResult {
  const authoritativeScope = normalizedScope(input.scope.authoritative);
  const pmxtScope = normalizedScope(input.scope.pmxt);
  const excluded = {
    scope: input.scope,
    excludedPmxtMarketIds: input.pmxtMarkets.map((market) => market.venueMarketId),
  };

  if (authoritativeScope.length === 0 || pmxtScope.length === 0) {
    return { outcome: "excluded", cause: "scope_unproven", ...excluded };
  }
  // Element-wise comparison of normalized scope arrays.
  const scopeMismatch =
    authoritativeScope.length !== pmxtScope.length ||
    authoritativeScope.some((v, i) => v !== pmxtScope[i]);
  if (scopeMismatch) {
    return { outcome: "excluded", cause: "scope_mismatch", ...excluded };
  }
  if (!input.pmxtScopedNativeIds) {
    return { outcome: "excluded", cause: "scope_unproven", ...excluded };
  }

  const scopedIds = {
    kalshi: new Set(input.pmxtScopedNativeIds.kalshi.map(normalizedId)),
    polymarket: new Set(input.pmxtScopedNativeIds.polymarket.map(normalizedId)),
  };
  const inScope: PmxtMarketSnapshot[] = [];
  const mappingFailures: PmxtMarketSnapshot[] = [];
  const excludedPmxtMarketIds: string[] = [];
  for (const market of input.pmxtMarkets) {
    const mapped = tryMapPmxtToVenue(market);
    if (mapped.kind === "failure") {
      mappingFailures.push(market);
    } else if (scopedIds[mapped.record.venue].has(mapped.record.venueNativeId)) {
      inScope.push(market);
    } else {
      excludedPmxtMarketIds.push(market.venueMarketId);
    }
  }

  return {
    outcome: "compared",
    cause: "scope_equivalent",
    scope: input.scope,
    coverage: comparePmxtCoverage({
      pmxtMarkets: [...inScope, ...mappingFailures],
      authoritativeKalshiMarkets: input.authoritativeKalshiMarkets,
      authoritativePolymarketMarkets: input.authoritativePolymarketMarkets,
    }),
    excludedPmxtMarketIds,
  };
}

function normalizedScope(scope: PmxtCoverageScope): string[] {
  return [...new Set(scope.values.map(normalizedId).filter(Boolean))].sort();
}

function normalizedId(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function tryMapPmxtToVenue(
  pmxtMarket: PmxtMarketSnapshot
): { kind: "success"; record: MappedPmxtRecord } | { kind: "failure"; failure: MappingFailure } {
  const payload = pmxtMarket.rawPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      kind: "failure",
      failure: {
        pmxtMarketId: pmxtMarket.venueMarketId,
        reasonCode: "missing_raw_payload",
        reason: `PMXT market ${pmxtMarket.venueMarketId} has no rawPayload`,
      },
    };
  }

  const sourceExchange =
    typeof pmxtMarket.sourceExchange === "string"
      ? pmxtMarket.sourceExchange.trim().toLowerCase()
      : typeof payload.sourceExchange === "string"
        ? payload.sourceExchange.trim().toLowerCase()
        : undefined;
  if (!sourceExchange) {
    return {
      kind: "failure",
      failure: {
        pmxtMarketId: pmxtMarket.venueMarketId,
        reasonCode: "ambiguous_source_exchange",
        reason: `PMXT market ${pmxtMarket.venueMarketId} has no sourceExchange in rawPayload`,
      },
    };
  }

  let venue: "kalshi" | "polymarket";
  if (sourceExchange === "kalshi") {
    venue = "kalshi";
  } else if (sourceExchange === "polymarket") {
    venue = "polymarket";
  } else {
    return {
      kind: "failure",
      failure: {
        pmxtMarketId: pmxtMarket.venueMarketId,
        reasonCode: "unrecognized_source_exchange",
        reason: `PMXT market ${pmxtMarket.venueMarketId} has unrecognized sourceExchange "${sourceExchange}"`,
      },
    };
  }

  const stampedNativeId =
    pmxtMarket.catalogMarketId && pmxtMarket.sourceExchange && pmxtMarket.venueMarketId
      ? normalizedId(pmxtMarket.venueMarketId)
      : undefined;
  const venueNativeId =
    stampedNativeId ||
    (typeof payload.venueMarketId === "string"
      ? payload.venueMarketId.trim().toLowerCase()
      : undefined);
  if (!venueNativeId) {
    return {
      kind: "failure",
      failure: {
        pmxtMarketId: pmxtMarket.venueMarketId,
        reasonCode: "missing_venue_native_id",
        reason: `PMXT market ${pmxtMarket.venueMarketId} has no proven venue-native ID`,
      },
    };
  }

  const status =
    typeof payload.status === "string" ? payload.status.trim().toLowerCase() : undefined;

  const hasResolutionText =
    typeof pmxtMarket.rawResolutionText === "string" &&
    pmxtMarket.rawResolutionText.trim().length > 0;

  return {
    kind: "success",
    record: {
      pmxtMarketId: pmxtMarket.venueMarketId,
      venue,
      venueNativeId,
      status,
      hasResolutionText,
      capturedAt: pmxtMarket.capturedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-venue coverage computation
// ---------------------------------------------------------------------------

function computeVenueCoverage(
  mappedRecords: MappedPmxtRecord[],
  authoritativeMarkets: VenueMarketSnapshot[]
): VenueCoverageResult {
  const authoritativeIds = new Set(
    authoritativeMarkets.map((m) => m.venueMarketId.toLowerCase())
  );

  // Build a map of venue-native ID → PMXT records for duplicate detection.
  const pmxtByNativeId = new Map<string, MappedPmxtRecord[]>();
  for (const record of mappedRecords) {
    const existing = pmxtByNativeId.get(record.venueNativeId);
    if (existing) {
      existing.push(record);
    } else {
      pmxtByNativeId.set(record.venueNativeId, [record]);
    }
  }

  const pmxtNativeIds = new Set(pmxtByNativeId.keys());

  // Overlap: native IDs present in both sets.
  const overlapIds = [...pmxtNativeIds].filter((id) => authoritativeIds.has(id));

  // Authoritative-only: in authoritative but not in PMXT.
  const authoritativeOnlyIds = [...authoritativeIds]
    .filter((id) => !pmxtNativeIds.has(id))
    .sort();

  // PMXT-only: in PMXT but not in authoritative.
  const pmxtOnlyIds = [...pmxtNativeIds]
    .filter((id) => !authoritativeIds.has(id))
    .sort();

  // Duplicate native IDs: same venue-native ID mapped from multiple PMXT records.
  const duplicateNativeIds: DuplicateNativeId[] = [];
  for (const [nativeId, records] of pmxtByNativeId) {
    if (records.length > 1) {
      duplicateNativeIds.push({
        venueNativeId: nativeId,
        pmxtMarketIds: records.map((r) => r.pmxtMarketId),
      });
    }
  }

  // Status disagreements and missing resolution text: single pass over
  // overlapping records.
  //
  // NOTE: The authoritative scan only fetches open markets, so any
  // overlapping PMXT record whose status is not "open" represents a
  // genuine disagreement — PMXT thinks the market is closed/settled
  // while the authoritative scan found it open. We do not compare
  // against the authoritative market's status because the authoritative
  // side is always open by construction (the scan scope is open-only).
  //
  // Deduplicate by (venueNativeId, pmxtStatus) for status disagreements
  // and by venueNativeId for missing resolution text, since multiple
  // PMXT records can map to the same native ID (duplicates).
  const statusDisagreements: StatusDisagreement[] = [];
  const seenDisagreements = new Set<string>();
  const missingResolutionText: string[] = [];
  const seenMissingText = new Set<string>();
  for (const overlapId of overlapIds) {
    for (const record of pmxtByNativeId.get(overlapId)!) {
      if (record.status && record.status !== "open") {
        const key = `${overlapId}:${record.status}`;
        if (!seenDisagreements.has(key)) {
          seenDisagreements.add(key);
          statusDisagreements.push({
            venueNativeId: overlapId,
            pmxtStatus: record.status,
          });
        }
      }
      if (!record.hasResolutionText && !seenMissingText.has(overlapId)) {
        seenMissingText.add(overlapId);
        missingResolutionText.push(overlapId);
      }
    }
  }

  return {
    authoritativeCount: authoritativeMarkets.length,
    pmxtMappedCount: mappedRecords.length,
    overlapCount: overlapIds.length,
    authoritativeOnlyIds,
    pmxtOnlyIds,
    duplicateNativeIds,
    statusDisagreements,
    missingResolutionText,
  };
}
