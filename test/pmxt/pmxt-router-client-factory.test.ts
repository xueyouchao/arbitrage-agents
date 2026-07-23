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
    await expect(
      client?.fetchMatchedMarketClusters({ marketId: "pmxt-kalshi-1" })
    ).resolves.toEqual([validCluster]);
    expect(FakeRouter.fetchParams).toEqual({
      marketId: "pmxt-kalshi-1",
      includeRawMatches: true,
      venues: ["kalshi", "polymarket"],
    });
  });

  it("anchors by marketId and does not let callers weaken direct-edge filters", async () => {
    const client = createPmxtRouterClient(
      { enabled: true, apiKey: "test-key", hostedBaseUrl: "https://api.pmxt.dev" },
      FakeRouter
    );

    await client?.fetchMatchedMarketClusters({ marketId: "pmxt-kalshi-1" });

    expect(FakeRouter.fetchParams).toEqual({
      marketId: "pmxt-kalshi-1",
      includeRawMatches: true,
      venues: ["kalshi", "polymarket"],
    });
  });

  it("anchors by slug", async () => {
    const client = createPmxtRouterClient(
      { enabled: true, apiKey: "test-key", hostedBaseUrl: "https://api.pmxt.dev" },
      FakeRouter
    );

    await client?.fetchMatchedMarketClusters({ slug: "btc-above-100k" });

    expect(FakeRouter.fetchParams).toEqual({
      slug: "btc-above-100k",
      includeRawMatches: true,
      venues: ["kalshi", "polymarket"],
    });
  });

  it("requires exactly one non-empty anchor instead of falling back globally", async () => {
    const client = createPmxtRouterClient(
      { enabled: true, apiKey: "test-key", hostedBaseUrl: "https://api.pmxt.dev" },
      FakeRouter
    );

    await expect(client?.fetchMatchedMarketClusters({ marketId: " " })).rejects.toThrow(
      "PMXT Router anchor"
    );
    await expect(client?.fetchMatchedMarketClusters({
      marketId: "market-1",
      slug: "slug-1",
    } as unknown as { marketId: string })).rejects.toThrow("PMXT Router anchor");
  });

  it("fetches multiple anchors and deduplicates clusters in stable first-seen order", async () => {
    const cluster2 = { ...validCluster, clusterId: "cluster-2" };
    const responses = [
      [validCluster, cluster2],
      [validCluster],
    ];
    class MultiAnchorRouter extends FakeRouter {
      async fetchMatchedMarketClusters(params: unknown) {
        FakeRouter.fetchParams = params;
        return responses.shift() ?? [];
      }
    }
    const client = createPmxtRouterClient(
      { enabled: true, apiKey: "test-key", hostedBaseUrl: "https://api.pmxt.dev" },
      MultiAnchorRouter
    );

    await expect(client?.fetchAnchoredMarketClusters([
      { marketId: "market-1" },
      { slug: "market-2" },
      { marketId: "market-1" },
    ])).resolves.toEqual([validCluster, cluster2]);
  });

  it("rejects malformed Router payloads and clusters missing rawMatches", async () => {
    FakeRouter.response = [{ clusterId: "cluster-1" }];
    const client = createPmxtRouterClient(
      {
        enabled: true,
        apiKey: "test-key",
        hostedBaseUrl: "https://api.pmxt.dev",
      },
      FakeRouter
    );

    await expect(
      client?.fetchMatchedMarketClusters({ marketId: "market-1" })
    ).rejects.toThrow("Invalid PMXT Router cluster");
    FakeRouter.response = [{ ...validCluster, rawMatches: undefined }];
    await expect(
      client?.fetchMatchedMarketClusters({ marketId: "market-1" })
    ).rejects.toThrow("Invalid PMXT Router cluster");
    FakeRouter.response = [validCluster];
  });
});
