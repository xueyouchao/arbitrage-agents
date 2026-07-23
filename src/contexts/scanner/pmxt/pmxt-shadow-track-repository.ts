import { EquivalentScopeCoverageResult, EquivalentScopeCoverageInput } from "./pmxt-coverage-comparator";
import { PmxtRouterProjectionResult } from "./pmxt-router-match-projector";
import { PmxtRouterAnchor } from "../../venues/infrastructure/pmxt/pmxt-router-client-factory";

export interface PmxtShadowTrackIdentity {
  authoritativeScanRunId: string;
  shadowRunId: string;
  shadowRunAttemptId: string;
}

export interface PmxtShadowMarketRecord {
  catalogMarketId: string;
  venue?: "kalshi" | "polymarket";
  venueNativeId?: string;
  eligible: boolean;
  exclusionReason?: string;
  capturedAt: string;
  payload: unknown;
}

export interface SavePmxtCoverage extends PmxtShadowTrackIdentity {
  scope: EquivalentScopeCoverageInput["scope"];
  result: EquivalentScopeCoverageResult;
  markets: PmxtShadowMarketRecord[];
}

export interface SavePmxtRouterProjection extends PmxtShadowTrackIdentity {
  anchors: PmxtRouterAnchor[];
  projection: PmxtRouterProjectionResult;
}

export interface PmxtShadowTrackRepository {
  saveCoverage(input: SavePmxtCoverage): Promise<void>;
  saveRouterProjection(input: SavePmxtRouterProjection): Promise<void>;
}
