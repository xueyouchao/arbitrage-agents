import { describe, expect, it, vi } from "vitest";
import { runPmxtHostedProbe } from "../../src/contexts/venues/infrastructure/pmxt/pmxt-hosted-probe";

class FakeExchange {
  constructor(public readonly options: Record<string, unknown> = {}) {}
  async fetchMarkets(): Promise<unknown[]> {
    return [];
  }
  async fetchOrderBooks(): Promise<Record<string, unknown>> {
    return {};
  }
}

describe("PMXT hosted probe", () => {
  it("fails closed and prints no diagnostics when shadowing is disabled", async () => {
    const output: string[] = [];
    await runPmxtHostedProbe(
      { pmxtShadowEnabled: false, pmxtShadowReadsEnabled: false },
      { print: (message: string) => output.push(message), newExchange: FakeExchange }
    );
    expect(output).toEqual(["PMXT shadowing is disabled; probe skipped"]);
  });

  it("fails closed when reads are disabled", async () => {
    const output: string[] = [];
    await runPmxtHostedProbe(
      { pmxtShadowEnabled: true, pmxtShadowReadsEnabled: false },
      { print: (message: string) => output.push(message), newExchange: FakeExchange }
    );
    expect(output).toEqual(["PMXT shadow reads are disabled; probe skipped"]);
  });

  it("does not construct the exchange when disabled", async () => {
    const newExchange = vi.fn();
    await runPmxtHostedProbe(
      { pmxtShadowEnabled: false, pmxtShadowReadsEnabled: false },
      { print: () => undefined, newExchange: newExchange as unknown as typeof FakeExchange }
    );
    expect(newExchange).not.toHaveBeenCalled();
  });

  it("prints aggregate diagnostics only and never calls account/write methods", async () => {
    const output: string[] = [];
    class ProbingExchange extends FakeExchange {
      async fetchMarkets(): Promise<unknown[]> {
        return [
          { id: "m1", title: "BTC above 100k?", outcomes: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] },
        ];
      }
      async fetchOrderBooks(): Promise<Record<string, unknown>> {
        return {
          o1: { asks: [{ price: 0.52, size: 10 }] },
          o2: { asks: [{ price: 0.48, size: 5 }] },
        };
      }
    }

    await runPmxtHostedProbe(
      {
        apiKey: "test-key",
        hostedBaseUrl: "https://hosted.pmxt.test/v1",
        pmxtShadowEnabled: true,
        pmxtShadowReadsEnabled: true,
      },
      { print: (message: string) => output.push(message), newExchange: ProbingExchange }
    );

    expect(output).toEqual([
      "pmxt markets=1",
      "pmxt books=1",
      "PMXT hosted probe: markets=1 books=1 stale=0",
    ]);
    for (const message of output) {
      expect(message).not.toMatch(/apiKey|key|token|secret|password|wallet|balance|position|order/i);
    }
  });
});
