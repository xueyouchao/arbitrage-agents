import { describe, expect, it, vi } from "vitest";
import {
  createPmxtHostedClient,
  PmxtHostedClientOptions,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-hosted-client-factory";

function validOptions(): PmxtHostedClientOptions {
  return {
    apiKey: "pmxt-test-key",
    hostedBaseUrl: "https://hosted.pmxt.test/v1",
    pmxtShadowEnabled: true,
    pmxtShadowReadsEnabled: true,
    autoStartServer: false,
  };
}

class FakeExchange {
  constructor(public readonly options: Record<string, unknown> = {}) {}
  async fetchMarkets(): Promise<unknown[]> {
    return [];
  }
  async fetchOrderBooks(): Promise<Record<string, unknown>> {
    return {};
  }
}

describe("PMXT hosted client factory disabled construction", () => {
  it("throws before any network call when shadowing is disabled", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), pmxtShadowEnabled: false }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT shadowing is disabled");
  });

  it("throws before any network call when reads are disabled", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), pmxtShadowReadsEnabled: false }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT shadow reads are disabled");
  });

  it("throws before constructing the exchange when disabled", async () => {
    const newExchange = vi.fn();
    await expect(
      createPmxtHostedClient(
        { ...validOptions(), pmxtShadowEnabled: false },
        { newExchange: newExchange as unknown as typeof FakeExchange }
      )
    ).rejects.toThrow("PMXT shadowing is disabled");
    expect(newExchange).not.toHaveBeenCalled();
  });

  it("does not require a real SDK import, venue credential, or wallet lookup when disabled", async () => {
    await expect(
      createPmxtHostedClient(
        { ...validOptions(), pmxtShadowEnabled: false },
        { newExchange: FakeExchange }
      )
    ).rejects.toThrow("PMXT shadowing is disabled");
  });

  it("rejects construction before spawning any child process or port probe", async () => {
    const newExchange = vi.fn().mockImplementation(() => {
      throw new Error("should not spawn");
    });
    await expect(
      createPmxtHostedClient(
        { ...validOptions(), pmxtShadowEnabled: false },
        { newExchange: newExchange as unknown as typeof FakeExchange }
      )
    ).rejects.toThrow("PMXT shadowing is disabled");
    expect(newExchange).not.toHaveBeenCalled();
  });
});
