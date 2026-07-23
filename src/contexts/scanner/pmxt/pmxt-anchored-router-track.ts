import { PmxtMarketSnapshot } from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import {
  PmxtRouterAnchor,
} from "../../venues/infrastructure/pmxt/pmxt-router-client-factory";
import {
  PmxtRouterCluster,
  PmxtRouterProjectionResult,
  projectPmxtRouterMatches,
} from "./pmxt-router-match-projector";
import { PmxtShadowTrackIdentity } from "./pmxt-shadow-track-repository";

export interface RunPmxtAnchoredRouterTrackInput extends PmxtShadowTrackIdentity {
  seriesScopedMarkets: PmxtMarketSnapshot[];
  routerClient: {
    fetchAnchoredMarketClusters(anchors: PmxtRouterAnchor[]): Promise<PmxtRouterCluster[]>;
  };
  repository: {
    saveRouterProjection(input: PmxtShadowTrackIdentity & {
      anchors: PmxtRouterAnchor[];
      projection: PmxtRouterProjectionResult;
    }): Promise<void>;
  };
}

export async function runPmxtAnchoredRouterTrack(
  input: RunPmxtAnchoredRouterTrackInput
): Promise<PmxtRouterProjectionResult> {
  const anchors: PmxtRouterAnchor[] = [];
  const nativeIdentities: Record<string, string> = {};
  for (const market of input.seriesScopedMarkets) {
    const catalogMarketId = market.catalogMarketId?.trim();
    if (!catalogMarketId) {
      throw new Error(`PMXT series-scoped market ${market.venueMarketId} lacks a catalog anchor`);
    }
    if (!market.sourceExchange || !market.venueMarketId.trim()) {
      throw new Error(`PMXT series-scoped market ${catalogMarketId} lacks proven native identity`);
    }
    anchors.push({ marketId: catalogMarketId });
    nativeIdentities[catalogMarketId] = market.venueMarketId.trim();
  }
  if (anchors.length === 0) {
    throw new Error("PMXT Router requires at least one series-scoped market anchor");
  }

  const clusters = await input.routerClient.fetchAnchoredMarketClusters(anchors);
  const projection = projectPmxtRouterMatches(clusters, nativeIdentities);
  await input.repository.saveRouterProjection({
    authoritativeScanRunId: input.authoritativeScanRunId,
    shadowRunId: input.shadowRunId,
    shadowRunAttemptId: input.shadowRunAttemptId,
    anchors,
    projection,
  });
  return projection;
}
