import { describe, expect, it } from "vitest";
import {
  collectPmxtShadowMetadata,
  computePmxtSdkIntegrity,
} from "../../src/contexts/venues/infrastructure/pmxt/pmxt-shadow-metadata";

describe("PMXT shadow metadata", () => {
  it("records exact approved SDK versions for pmxtjs and pmxt-core", () => {
    const meta = collectPmxtShadowMetadata();
    const pmxtjs = meta.sdkVersions.find((v) => v.package === "pmxtjs");
    const pmxtCore = meta.sdkVersions.find((v) => v.package === "pmxt-core");

    expect(pmxtjs).toBeDefined();
    expect(pmxtCore).toBeDefined();
    expect(pmxtjs!.version).toBeTruthy();
    expect(pmxtCore!.version).toBeTruthy();
    // Both packages are pinned to the same version
    expect(pmxtjs!.version).toBe(pmxtCore!.version);
  });

  it("records the package license for each SDK package", () => {
    const meta = collectPmxtShadowMetadata();
    for (const sdk of meta.sdkVersions) {
      expect(sdk.license).toBeTruthy();
      expect(typeof sdk.license).toBe("string");
    }
    const pmxtCore = meta.sdkVersions.find((v) => v.package === "pmxt-core")!;
    expect(pmxtCore.license).toBe("MIT");
  });

  it("records integrity metadata for each SDK package", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.sdkIntegrity).toHaveLength(2);

    for (const entry of meta.sdkIntegrity) {
      expect(entry.package).toMatch(/^pmxt(js|-core)$/);
      expect(entry.version).toBeTruthy();
      expect(entry.sha512).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it("computes deterministic integrity hashes from package contents", () => {
    const integrity = computePmxtSdkIntegrity("pmxtjs");
    expect(integrity.package).toBe("pmxtjs");
    expect(integrity.version).toBeTruthy();
    expect(integrity.sha512).toMatch(/^[0-9a-f]{128}$/);

    const again = computePmxtSdkIntegrity("pmxtjs");
    expect(again.sha512).toBe(integrity.sha512);
  });

  it("records the hosted base URL and trade URL endpoints", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.endpointAvailability.hostedBaseUrl).toBe("https://api.pmxt.dev");
    expect(meta.endpointAvailability.tradeBaseUrl).toBe("https://trade.pmxt.dev");
  });

  it("records read-only catalog endpoints available on the Free tier", () => {
    const meta = collectPmxtShadowMetadata();
    const catalog = meta.endpointAvailability.catalogEndpoints;
    expect(catalog).toContain("fetchMarkets");
    expect(catalog).toContain("fetchOrderBooks");
    expect(catalog).toContain("fetchOHLCV");
    expect(catalog).toContain("fetchTrades");
    expect(catalog).toContain("fetchEvents");
  });

  it("records trading and account endpoints that are excluded from the operating boundary", () => {
    const meta = collectPmxtShadowMetadata();
    const trading = meta.endpointAvailability.tradingEndpoints;
    expect(trading).toContain("createOrder");
    expect(trading).toContain("cancelOrder");

    const account = meta.endpointAvailability.accountEndpoints;
    expect(account).toContain("fetchBalance");
    expect(account).toContain("fetchPositions");
  });

  it("records that walletAddress is required for hosted reads", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.freeTierLimits.walletAddressRequired).toBe(true);
  });

  it("records Free-tier rate limits and concurrency constraints", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.freeTierLimits.maxRequestsPerMinute).toBeGreaterThan(0);
    expect(meta.freeTierLimits.maxConcurrency).toBeGreaterThan(0);
  });

  it("records bulk-call billing behavior", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.freeTierLimits.bulkCallBilling).toBeTruthy();
    expect(typeof meta.freeTierLimits.bulkCallBilling).toBe("string");
  });

  it("records quota-exhaustion behavior", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.freeTierLimits.quotaExhaustionBehavior).toBeTruthy();
    expect(typeof meta.freeTierLimits.quotaExhaustionBehavior).toBe("string");
  });

  it("records relevant response headers for rate-limit tracking", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.freeTierLimits.rateLimitHeaders).toBeTruthy();
    expect(Array.isArray(meta.freeTierLimits.rateLimitHeaders)).toBe(true);
    expect(meta.freeTierLimits.rateLimitHeaders.length).toBeGreaterThan(0);
  });

  it("records native market identity fields from approved package types", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.marketIdentity.marketIdField).toBe("marketId");
    expect(meta.marketIdentity.outcomeIdField).toBe("outcomeId");
    expect(meta.marketIdentity.binaryOrientation).toMatch(/yes.*no/i);
  });

  it("records native timestamp format and field names", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.marketIdentity.timestampFormat).toBeTruthy();
    expect(meta.marketIdentity.timestampField).toBeTruthy();
    expect(meta.marketIdentity.timestampFormat).toContain("unix");
  });

  it("records a recordedAt timestamp for the metadata snapshot", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.recordedAt).toBeTruthy();
    expect(() => new Date(meta.recordedAt)).not.toThrow();
  });

  it("never includes API keys, secrets, or wallet addresses in metadata", () => {
    const meta = collectPmxtShadowMetadata();
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toMatch(/pmxt_live_/i);
    expect(serialized).not.toMatch(/0x[a-fA-F0-9]{40}/);
    expect(serialized).not.toMatch(/privateKey|secret|password/i);
  });

  it("records the operating boundary exclusions explicitly", () => {
    const meta = collectPmxtShadowMetadata();
    expect(meta.operatingBoundary).toBeDefined();
    expect(meta.operatingBoundary.excludesExecution).toBe(true);
    expect(meta.operatingBoundary.excludesAccountAccess).toBe(true);
    expect(meta.operatingBoundary.excludesCommercialResale).toBe(true);
    expect(meta.operatingBoundary.excludesCompetitiveProduct).toBe(true);
    expect(meta.operatingBoundary.excludesPublicBenchmark).toBe(true);
    expect(meta.operatingBoundary.excludesReverseEngineering).toBe(true);
    expect(meta.operatingBoundary.excludesControlCircumvention).toBe(true);
    expect(meta.operatingBoundary.excludesDatabaseReconstruction).toBe(true);
  });
});
