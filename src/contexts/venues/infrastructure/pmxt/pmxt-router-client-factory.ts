import { PmxtRouterCluster } from "../../../scanner/pmxt/pmxt-router-match-projector";

export interface PmxtRouterClientOptions {
  enabled: boolean;
  apiKey?: string;
  hostedBaseUrl?: string;
}

export interface PmxtRouterSdkClient {
  fetchMatchedMarketClusters(params: unknown): Promise<unknown[]>;
}

export interface PmxtRouterClient {
  fetchMatchedMarketClusters(): Promise<PmxtRouterCluster[]>;
}

export interface PmxtRouterConstructor {
  new (options?: Record<string, unknown>): PmxtRouterSdkClient;
}

export function createPmxtRouterClient(
  options: PmxtRouterClientOptions,
  Router: PmxtRouterConstructor = require("pmxtjs").Router
): PmxtRouterClient | undefined {
  if (!options.enabled) {
    return undefined;
  }
  if (!options.apiKey?.trim()) {
    throw new Error("PMXT Router requires an API key");
  }
  if (!options.hostedBaseUrl?.trim()) {
    throw new Error("PMXT Router requires a hosted base URL");
  }

  const router = new Router({
    pmxtApiKey: options.apiKey,
    baseUrl: options.hostedBaseUrl,
    autoStartServer: false,
  });

  return {
    async fetchMatchedMarketClusters(): Promise<PmxtRouterCluster[]> {
      const clusters = await router.fetchMatchedMarketClusters({
        includeRawMatches: true,
        venues: ["kalshi", "polymarket"],
      });
      return clusters.map(parseRouterCluster);
    },
  };
}

function parseRouterCluster(value: unknown): PmxtRouterCluster {
  if (!isRecord(value)) throw new Error("Invalid PMXT Router cluster: expected object");
  if (
    !nonEmptyString(value.clusterId) ||
    !(value.canonicalTitle === null || typeof value.canonicalTitle === "string") ||
    !Array.isArray(value.relations) ||
    !value.relations.every(isMatchRelation) ||
    !validConfidence(value.confidence) ||
    !Array.isArray(value.markets) ||
    !value.markets.every(isRouterMember) ||
    !Array.isArray(value.rawMatches) ||
    !value.rawMatches.every(isRawMatch)
  ) {
    throw new Error("Invalid PMXT Router cluster: malformed fields");
  }
  return value as unknown as PmxtRouterCluster;
}

function isRouterMember(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.marketId) &&
    nonEmptyString(value.title) &&
    (value.sourceExchange === undefined || typeof value.sourceExchange === "string")
  );
}

function isRawMatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmptyString(value.marketAId) &&
    nonEmptyString(value.marketBId) &&
    isMatchRelation(value.relation) &&
    validConfidence(value.confidence)
  );
}

function isMatchRelation(value: unknown): boolean {
  return ["identity", "complement", "subset", "superset", "overlap", "disjoint"].includes(
    String(value)
  );
}

function validConfidence(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
