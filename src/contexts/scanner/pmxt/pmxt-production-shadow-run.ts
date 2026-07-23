import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import {
  mapPmxtMarketToSnapshot,
  PmxtMarket,
  PmxtMarketSnapshot,
  PmxtMarketMappingStamp,
} from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import {
  fetchSeriesMarketCatalog,
  PmxtSeriesCatalogClient,
  PmxtSeriesCatalogMarket,
} from "../../venues/infrastructure/pmxt/pmxt-series-market-catalog";
import { comparePmxtCoverageWithinEquivalentScope } from "./pmxt-coverage-comparator";
import { runPmxtAnchoredRouterTrack } from "./pmxt-anchored-router-track";
import {
  PmxtShadowTrackCoordinator,
  PmxtShadowTrackCoordinatorResult,
  PmxtShadowTrackMode,
  ExcludedTrackError,
} from "./pmxt-shadow-track-coordinator";
import {
  PmxtShadowMarketRecord,
  PmxtShadowTrackIdentity,
  PmxtShadowTrackRepository,
} from "./pmxt-shadow-track-repository";
import { PmxtAuthoritativeMarketSnapshotRepository } from "./pmxt-authoritative-market-snapshot-repository";

export interface PmxtProductionShadowRunDeps {
  authoritativeRepository: PmxtAuthoritativeMarketSnapshotRepository;
  kalshiCatalogClient: PmxtSeriesCatalogClient;
  polymarketCatalogClient: PmxtSeriesCatalogClient;
  routerClient?: Parameters<typeof runPmxtAnchoredRouterTrack>[0]["routerClient"];
  repository: PmxtShadowTrackRepository;
  kalshiSeries: string;
  polymarketSeries: string;
  readsEnabled: boolean;
  routerEnabled: boolean;
  clock?: () => string;
}

export interface PmxtProductionShadowRunResult {
  status: "completed" | "partial" | "failed";
  reason?: string;
  tracks: PmxtShadowTrackCoordinatorResult["tracks"];
}

interface Catalogs {
  kalshi: PmxtSeriesCatalogMarket[];
  polymarket: PmxtSeriesCatalogMarket[];
}

interface MappedCatalogs {
  snapshots: PmxtMarketSnapshot[];
  records: PmxtShadowMarketRecord[];
  scopedNativeIds: { kalshi: string[]; polymarket: string[] };
  scopeProven: boolean;
}

export class PmxtProductionShadowRun {
  private readonly clock: () => string;

  constructor(private readonly deps: PmxtProductionShadowRunDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async runClaimedShadow(identity: PmxtShadowTrackIdentity): Promise<PmxtProductionShadowRunResult> {
    const authoritativeMarkets = await this.deps.authoritativeRepository.listByScanRunId(
      identity.authoritativeScanRunId
    );
    let catalogsPromise: Promise<Catalogs> | undefined;
    const catalogs = () => catalogsPromise ??= this.fetchCatalogs().catch((e) => {
      catalogsPromise = undefined; // Do not cache a rejection — allow retry.
      throw e;
    });
    // Share mapped catalogs across tracks — fetch once, map once.
    let mappedPromise: Promise<MappedCatalogs> | undefined;
    const mapped = () => mappedPromise ??= catalogs().then((c) => this.mapCatalogs(c)).catch((e) => {
      mappedPromise = undefined; // Do not cache a rejection — allow retry.
      throw e;
    });
    const mode = trackMode(this.deps.readsEnabled, this.deps.routerEnabled);

    // Prove scope from authoritative sourcePayload, not from config alone.
    const provenScope = proveAuthoritativeScope(authoritativeMarkets, this.deps.kalshiSeries, this.deps.polymarketSeries);

    let readsExcludedReason: string | undefined;
    let routerExcludedReason: string | undefined;
    const coordinator = new PmxtShadowTrackCoordinator({
      runReadsTrack: async () => {
        const m = await mapped();
        const scope = {
          authoritative: {
            kind: "series" as const,
            values: provenScope.authoritative,
          },
          pmxt: {
            kind: "series" as const,
            values: m.scopeProven
              ? provenScope.authoritative
              : [],
          },
        };
        const result = comparePmxtCoverageWithinEquivalentScope({
          pmxtMarkets: m.snapshots,
          authoritativeKalshiMarkets: authoritativeMarkets.filter((market) => market.venue === "kalshi"),
          authoritativePolymarketMarkets: authoritativeMarkets.filter((market) => market.venue === "polymarket"),
          scope,
          pmxtScopedNativeIds: m.scopeProven ? m.scopedNativeIds : undefined,
        });
        await this.deps.repository.saveCoverage({ ...identity, scope, result, markets: m.records });
        if (result.outcome === "excluded") {
          readsExcludedReason = result.cause;
          throw new ExcludedTrackError(result.cause);
        }
      },
      runRouterTrack: async () => {
        if (!this.deps.routerClient) throw new Error("PMXT Router client is unavailable");
        const m = await mapped();
        if (!m.scopeProven) {
          routerExcludedReason = "scope_unproven";
          throw new ExcludedTrackError("scope_unproven");
        }
        await runPmxtAnchoredRouterTrack({
          ...identity,
          seriesScopedMarkets: m.snapshots.filter((market) =>
            m.records.some((record) => record.catalogMarketId === market.catalogMarketId && record.eligible)
          ),
          routerClient: this.deps.routerClient,
          repository: this.deps.repository,
        });
      },
    });

    const coordinated = await coordinator.run({ ...identity, mode });
    return summarize(coordinated, readsExcludedReason, routerExcludedReason);
  }

  private async fetchCatalogs(): Promise<Catalogs> {
    const [kalshi, polymarket] = await Promise.all([
      fetchSeriesMarketCatalog(this.deps.kalshiCatalogClient, this.deps.kalshiSeries),
      fetchSeriesMarketCatalog(this.deps.polymarketCatalogClient, this.deps.polymarketSeries),
    ]);
    return { kalshi, polymarket };
  }

  private mapCatalogs(catalogs: Catalogs): MappedCatalogs {
    const snapshots: PmxtMarketSnapshot[] = [];
    const records: PmxtShadowMarketRecord[] = [];
    const scopedNativeIds = { kalshi: [] as string[], polymarket: [] as string[] };
    let scopeProven = catalogs.kalshi.length > 0 && catalogs.polymarket.length > 0;

    for (const [venue, markets] of Object.entries(catalogs) as Array<
      ["kalshi" | "polymarket", PmxtSeriesCatalogMarket[]]
    >) {
      for (const market of markets) {
        const capturedAt = this.clock();
        try {
          const stamp = nativeStamp(venue, market);
          const snapshot = mapPmxtMarketToSnapshot(market as PmxtMarket, capturedAt, stamp);
          snapshots.push(snapshot);
          scopedNativeIds[venue].push(snapshot.venueMarketId);
          records.push({
            catalogMarketId: market.marketId,
            venue,
            venueNativeId: snapshot.venueMarketId,
            eligible: true,
            capturedAt,
            payload: market,
          });
        } catch (error) {
          // Individual market mapping failures are isolated — they do not
          // invalidate the entire venue scope. The scope is proven by the
          // presence of markets from both venues, not by every market mapping
          // succeeding.
          records.push({
            catalogMarketId: market.marketId,
            venue,
            eligible: false,
            exclusionReason: error instanceof Error ? error.message : String(error),
            capturedAt,
            payload: market,
          });
        }
      }
    }
    return { snapshots, records, scopedNativeIds, scopeProven };
  }
}

function nativeStamp(
  venue: "kalshi" | "polymarket",
  market: PmxtSeriesCatalogMarket
): PmxtMarketMappingStamp {
  if (venue === "kalshi") {
    if (typeof market.slug !== "string" || !market.slug.trim()) {
      throw new Error(`PMXT Kalshi market ${market.marketId} native ticker is not proven`);
    }
    // SDK orientation: use market.yes/no outcomeId when available.
    const orientation = resolveSdkOrientation(market);
    return {
      sourceExchange: "kalshi",
      nativeMarketIdentity: { kind: "ticker", value: market.slug },
      ...(orientation ? { outcomeOrientation: orientation } : {}),
    };
  }
  if (typeof market.contractAddress !== "string" || !market.contractAddress.trim()) {
    throw new Error(`PMXT Polymarket market ${market.marketId} native conditionId is not proven`);
  }
  const orientation = resolveSdkOrientation(market);
  return {
    sourceExchange: "polymarket",
    nativeMarketIdentity: { kind: "conditionId", value: market.contractAddress },
    ...(orientation ? { outcomeOrientation: orientation } : {}),
  };
}

/**
 * Resolve explicit yes/no outcome orientation from the SDK market payload.
 * Uses market.yes.outcomeId / market.no.outcomeId when available and validates
 * both exist in the outcomes array.
 */
function resolveSdkOrientation(
  market: PmxtSeriesCatalogMarket
): { yesOutcomeId: string; noOutcomeId: string } | undefined {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  if (outcomes.length !== 2) return undefined;

  const yesRef = (market as Record<string, unknown>).yes;
  const noRef = (market as Record<string, unknown>).no;

  if (!isRecord(yesRef) || !isRecord(noRef)) return undefined;

  const yesId = typeof yesRef.outcomeId === "string" ? yesRef.outcomeId.trim() : undefined;
  const noId = typeof noRef.outcomeId === "string" ? noRef.outcomeId.trim() : undefined;

  if (!yesId || !noId || yesId === noId) return undefined;

  // Validate both exist in outcomes.
  const outcomeIds = outcomes
    .map((o: unknown) => isRecord(o) && typeof o.outcomeId === "string" ? (o as Record<string, unknown>).outcomeId as string : undefined)
    .filter(Boolean);
  if (!outcomeIds.includes(yesId) || !outcomeIds.includes(noId)) return undefined;

  return { yesOutcomeId: yesId, noOutcomeId: noId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify that the claimed authoritative scan contains markets from both
 * configured venues. Kalshi tickers must match the configured series prefix.
 * For Polymarket, the PMXT series slug (e.g. "btc-multi-strikes-weekly") is
 * a PMXT concept, not a Polymarket native market slug — individual market
 * slugs will never match it. Instead we verify the authoritative scan has at
 * least one Polymarket market with a non-empty venueMarketId (conditionId).
 *
 * Returns an empty authoritative array (scope_unproven) when either venue
 * has zero markets in the claimed scan, which indicates a config mismatch
 * or a global/non-series scan. The operator must ensure the authoritative
 * and shadow workers use the same series configuration.
 */
function proveAuthoritativeScope(
  authoritativeMarkets: readonly VenueMarketSnapshot[],
  kalshiSeries: string,
  polymarketSeries: string
): { authoritative: string[] } {
  const kalshiPrefix = kalshiSeries.trim().toLowerCase();

  let kalshiProven = false;
  let polymarketProven = false;

  for (const market of authoritativeMarkets) {
    if (market.venue === "kalshi" && !kalshiProven) {
      const ticker = market.venueMarketId?.trim().toLowerCase() ?? "";
      if (ticker && ticker.startsWith(kalshiPrefix)) {
        kalshiProven = true;
      }
    }
    if (market.venue === "polymarket" && !polymarketProven) {
      // A non-empty conditionId proves the scan captured Polymarket markets.
      if (market.venueMarketId && market.venueMarketId.trim().length > 0) {
        polymarketProven = true;
      }
    }
    if (kalshiProven && polymarketProven) break;
  }

  if (!kalshiProven || !polymarketProven) {
    return { authoritative: [] };
  }

  return { authoritative: [kalshiSeries, polymarketSeries] };
}

function trackMode(readsEnabled: boolean, routerEnabled: boolean): PmxtShadowTrackMode {
  if (readsEnabled && routerEnabled) return "both";
  if (readsEnabled) return "reads-only";
  if (routerEnabled) return "router-only";
  throw new Error("PMXT production shadow run requires at least one track");
}

function summarize(
  result: PmxtShadowTrackCoordinatorResult,
  readsExcludedReason?: string,
  routerExcludedReason?: string
): PmxtProductionShadowRunResult {
  const requested = [result.tracks.reads, result.tracks.router].filter(
    (track) => track.status !== "not_requested"
  );
  const failures = Object.entries(result.tracks)
    .filter((entry): entry is [string, { status: "failed"; reason: string }] => entry[1].status === "failed")
    .map(([track, outcome]) => `${track}: ${outcome.reason}`);
  const reasons = [
    ...(readsExcludedReason ? [`reads: ${readsExcludedReason}`] : []),
    ...(routerExcludedReason ? [`router: ${routerExcludedReason}`] : []),
    ...failures,
  ];
  const status = readsExcludedReason || routerExcludedReason
    ? "partial"
    : failures.length === 0
      ? "completed"
      : failures.length === requested.length
        ? "failed"
        : "partial";
  return {
    status,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    tracks: result.tracks,
  };
}
