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
      return clusters as PmxtRouterCluster[];
    },
  };
}
