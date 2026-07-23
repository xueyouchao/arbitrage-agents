import { describe, expect, it, vi } from "vitest";
import { PmxtShadowTrackCoordinator } from "../../src/contexts/scanner/pmxt/pmxt-shadow-track-coordinator";

const identity = {
  authoritativeScanRunId: "scan-1",
  shadowRunId: "shadow-1",
  shadowRunAttemptId: "attempt-1",
};

function buildCoordinator(overrides: {
  reads?: () => Promise<void>;
  router?: () => Promise<void>;
} = {}) {
  return new PmxtShadowTrackCoordinator({
    runReadsTrack: overrides.reads ?? vi.fn().mockResolvedValue(undefined),
    runRouterTrack: overrides.router ?? vi.fn().mockResolvedValue(undefined),
  });
}

describe("PmxtShadowTrackCoordinator", () => {
  it.each([
    ["reads-only", 1, 0],
    ["router-only", 0, 1],
    ["both", 1, 1],
  ] as const)("runs the %s boundary", async (mode, readsCalls, routerCalls) => {
    const reads = vi.fn().mockResolvedValue(undefined);
    const router = vi.fn().mockResolvedValue(undefined);
    const coordinator = buildCoordinator({ reads, router });

    const result = await coordinator.run({ ...identity, mode });

    expect(reads).toHaveBeenCalledTimes(readsCalls);
    expect(router).toHaveBeenCalledTimes(routerCalls);
    expect(result.mode).toBe(mode);
  });

  it("keeps both tracks independent when reads fails", async () => {
    const reads = vi.fn().mockRejectedValue(new Error("reads unavailable"));
    const router = vi.fn().mockResolvedValue(undefined);

    const result = await buildCoordinator({ reads, router }).run({ ...identity, mode: "both" });

    expect(router).toHaveBeenCalledTimes(1);
    expect(result.tracks).toEqual({
      reads: { status: "failed", reason: "reads unavailable" },
      router: { status: "completed" },
    });
  });

  it("keeps both tracks independent when Router fails", async () => {
    const reads = vi.fn().mockResolvedValue(undefined);
    const router = vi.fn().mockRejectedValue(new Error("router unavailable"));

    const result = await buildCoordinator({ reads, router }).run({ ...identity, mode: "both" });

    expect(reads).toHaveBeenCalledTimes(1);
    expect(result.tracks).toEqual({
      reads: { status: "completed" },
      router: { status: "failed", reason: "router unavailable" },
    });
  });
});
