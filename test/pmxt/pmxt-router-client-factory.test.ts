import { describe, expect, it, vi } from "vitest";
import {
  createPmxtRouterClient,
  PmxtRouterSdkClient,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-router-client-factory";

const validCluster = {
  clusterId: "cluster-1",
  canonicalTitle: "Will BTC exceed $100,000?",
  relations: ["identity"],
  confidence: 0.9,
  markets: [
    {
      marketId: "kalshi-1",
      sourceExchange: "kalshi",
      title: "Will BTC exceed $100,000?",
    },
  ],
  rawMatches: [],
};

class FakeRouter implements PmxtRouterSdkClient {
  static options: unknown;
  static fetchParams: unknown;
  static response: unknown[] = [validCluster];

  constructor(options: unknown) {
    FakeRouter.options = options;
  }

  async fetchMatchedMarketClusters(params: unknown) {
    FakeRouter.fetchParams = params;
    return FakeRouter.response;
  }
}

describe("createPmxtRouterClient", () => {
  it("fails closed without constructing the SDK when Router mode is disabled", () => {
    const constructor = vi.fn();

    expect(
      createPmxtRouterClient(
        {
          enabled: false,
          apiKey: undefined,
          hostedBaseUrl: undefined,
        },
        constructor
      )
    ).toBeUndefined();
    expect(constructor).not.toHaveBeenCalled();
  });

  it("requires hosted credentials when Router mode is enabled", () => {
    expect(() =>
      createPmxtRouterClient(
        {
          enabled: true,
          apiKey: undefined,
          hostedBaseUrl: "https://api.pmxt.dev",
        },
        FakeRouter
      )
    ).toThrow("PMXT Router requires an API key");
  });

  it("disables auto-start and always requests intact direct edges for both venues", async () => {
    const client = createPmxtRouterClient(
      {
        enabled: true,
        apiKey: "test-key",
        hostedBaseUrl: "https://api.pmxt.dev",
      },
      FakeRouter
    );

    expect(FakeRouter.options).toEqual({
      pmxtApiKey: "test-key",
      baseUrl: "https://api.pmxt.dev",
      autoStartServer: false,
    });
    await expect(client?.fetchMatchedMarketClusters()).resolves.toEqual([validCluster]);
    expect(FakeRouter.fetchParams).toEqual({
      includeRawMatches: true,
      venues: ["kalshi", "polymarket"],
    });
  });

  it("rejects malformed Router payloads at the SDK boundary", async () => {
    FakeRouter.response = [{ clusterId: "cluster-1" }];
    const client = createPmxtRouterClient(
      {
        enabled: true,
        apiKey: "test-key",
        hostedBaseUrl: "https://api.pmxt.dev",
      },
      FakeRouter
    );

    await expect(client?.fetchMatchedMarketClusters()).rejects.toThrow(
      "Invalid PMXT Router cluster"
    );
    FakeRouter.response = [validCluster];
  });
});
