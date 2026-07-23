import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../src/config/app-config";
import { createPmxtProductionRunner } from "../../src/contexts/scanner/pmxt/pmxt-shadow.module";

function disabledConfig() {
  return loadAppConfig({
    DATABASE_URL: "postgres://localhost/arbitrage_agents",
    PMXT_SHADOW_ENABLED: "false",
    PMXT_SHADOW_READS_ENABLED: "false",
    PMXT_SHADOW_ROUTER_ENABLED: "false",
  });
}

describe("createPmxtProductionRunner", () => {
  it("does not invoke PMXT SDK factories when shadowing is disabled", async () => {
    const hostedFactory = vi.fn();
    const routerFactory = vi.fn();

    const runner = await createPmxtProductionRunner(
      disabledConfig(),
      {} as never,
      {} as never,
      {} as never,
      { hostedFactory, routerFactory }
    );

    expect(runner).toBeUndefined();
    expect(hostedFactory).not.toHaveBeenCalled();
    expect(routerFactory).not.toHaveBeenCalled();
  });

  it("awaits two real hosted catalog clients and wires production dependencies", async () => {
    const kalshiClient = { fetchEvents: vi.fn() };
    const polymarketClient = { fetchEvents: vi.fn() };
    const hostedFactory = vi.fn()
      .mockResolvedValueOnce(kalshiClient)
      .mockResolvedValueOnce(polymarketClient);
    const routerClient = { fetchAnchoredMarketClusters: vi.fn() };
    const routerFactory = vi.fn().mockReturnValue(routerClient);
    const config = loadAppConfig({
      DATABASE_URL: "postgres://localhost/arbitrage_agents",
      PMXT_API_KEY: "test-key",
      PMXT_HOSTED_BASE_URL: "https://pmxt.example.com",
      PMXT_SHADOW_ENABLED: "true",
      PMXT_SHADOW_READS_ENABLED: "false",
      PMXT_SHADOW_ROUTER_ENABLED: "true",
      PMXT_SHADOW_SAMPLE_RATE: "1/1",
      PMXT_SHADOW_MAX_QUEUE_DEPTH: "10",
      PMXT_SHADOW_MAX_QUEUE_WAIT_MS: "1000",
      PMXT_SHADOW_MAX_REQUESTS_PER_RUN: "10",
      PMXT_SHADOW_MAX_MONTHLY_CREDITS: "100",
      PMXT_SHADOW_MAX_MONTHLY_COST_USD: "1",
    });

    const runner = await createPmxtProductionRunner(
      config,
      {} as never,
      {} as never,
      {} as never,
      { hostedFactory, routerFactory }
    );

    expect(hostedFactory).toHaveBeenCalledTimes(2);
    expect(hostedFactory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      venue: "kalshi",
      pmxtShadowReadsEnabled: true,
    }));
    expect(hostedFactory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      venue: "polymarket",
      pmxtShadowReadsEnabled: true,
    }));
    expect(routerFactory).toHaveBeenCalledTimes(1);
    expect(runner).toBeDefined();
  });
});
