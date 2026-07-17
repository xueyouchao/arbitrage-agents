import { describe, expect, it, vi } from "vitest";
import {
  createPmxtRouterClient,
  PmxtRouterSdkClient,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-router-client-factory";

class FakeRouter implements PmxtRouterSdkClient {
  static options: unknown;
  static fetchParams: unknown;

  constructor(options: unknown) {
    FakeRouter.options = options;
  }

  async fetchMatchedMarketClusters(params: unknown) {
    FakeRouter.fetchParams = params;
    return [{ clusterId: "cluster-1" }];
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
    await expect(client?.fetchMatchedMarketClusters()).resolves.toEqual([
      { clusterId: "cluster-1" },
    ]);
    expect(FakeRouter.fetchParams).toEqual({
      includeRawMatches: true,
      venues: ["kalshi", "polymarket"],
    });
  });
});
