import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

describe("PMXT hosted client factory", () => {
  it("rejects construction when PMXT shadowing is disabled", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), pmxtShadowEnabled: false }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT shadowing is disabled");
  });

  it("rejects construction when reads are disabled", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), pmxtShadowReadsEnabled: false }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT shadow reads are disabled");
  });

  it("rejects construction when the API key is missing", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), apiKey: "" }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT_API_KEY is required");
  });

  it("rejects construction when the hosted base URL is missing", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), hostedBaseUrl: "" }, { newExchange: FakeExchange })
    ).rejects.toThrow("PMXT_HOSTED_BASE_URL is required");
  });

  it("rejects construction when autoStartServer is true", async () => {
    await expect(
      createPmxtHostedClient({ ...validOptions(), autoStartServer: true }, { newExchange: FakeExchange })
    ).rejects.toThrow("autoStartServer must be false");
  });

  it("does not construct the exchange when disabled", async () => {
    const newExchange = vi.fn();
    await expect(
      createPmxtHostedClient(
        { ...validOptions(), pmxtShadowEnabled: false },
        { newExchange: newExchange as unknown as typeof FakeExchange }
      )
    ).rejects.toThrow("PMXT shadowing is disabled");
    expect(newExchange).not.toHaveBeenCalled();
  });

  it("creates a client when all guard conditions are satisfied", async () => {
    const client = await createPmxtHostedClient(validOptions(), { newExchange: FakeExchange });
    expect(client.fetchMarkets).toEqual(expect.any(Function));
    expect(client.fetchOrderBooks).toEqual(expect.any(Function));
  });

  it("hardcodes autoStartServer to false", async () => {
    const newExchange = vi.fn().mockReturnValue(new FakeExchange({}));
    await createPmxtHostedClient(
      { ...validOptions(), autoStartServer: undefined as unknown as boolean },
      { newExchange }
    );
    expect(newExchange).toHaveBeenCalledWith(
      expect.objectContaining({ autoStartServer: false })
    );
  });

  it("pins pmxtjs and pmxt-core to exact versions", () => {
    const lockfile = JSON.parse(readFileSync("package-lock.json", "utf-8"));
    expect(lockfile.packages["node_modules/pmxtjs"].version).toBe("2.51.4");
    expect(lockfile.packages["node_modules/pmxt-core"].version).toBe("2.51.4");
  });
});
