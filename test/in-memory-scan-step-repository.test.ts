import { describe, expect, it } from "vitest";
import { InMemoryScanStepRepository } from "../src/contexts/scanner/in-memory-scanner-repository";

describe("InMemoryScanStepRepository", () => {
  it("byRunId groups steps by scanRunId", () => {
    const repo = new InMemoryScanStepRepository();
    repo.saveStep({ scanRunId: "run-1", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-01-01", completedAt: "2026-01-01", metadata: {} });
    repo.saveStep({ scanRunId: "run-1", stepName: "step2", status: "succeeded", startedAt: "2026-01-01", completedAt: "2026-01-01", metadata: {} });
    repo.saveStep({ scanRunId: "run-2", stepName: "fetch_markets", status: "succeeded", startedAt: "2026-01-01", completedAt: "2026-01-01", metadata: {} });
    const byRunId = repo.byRunId;
    expect(byRunId.size).toBe(2);
    expect(byRunId.get("run-1")).toHaveLength(2);
    expect(byRunId.get("run-2")).toHaveLength(1);
  });

  it("getStep returns latest attempt for a step", async () => {
    const repo = new InMemoryScanStepRepository();
    repo.saveStep({ scanRunId: "run-1", stepName: "fetch_markets", attempt: 1, status: "failed", startedAt: "2026-01-01", completedAt: "2026-01-01", failureReason: "network", metadata: {} });
    repo.saveStep({ scanRunId: "run-1", stepName: "fetch_markets", attempt: 2, status: "succeeded", startedAt: "2026-01-01", completedAt: "2026-01-01", metadata: {} });
    const step = await repo.getStep("run-1", "fetch_markets");
    expect(step).toBeDefined();
    expect(step!.status).toBe("succeeded");
    expect(step!.attempt).toBe(2);
    const missing = await repo.getStep("run-1", "nonexistent");
    expect(missing).toBeUndefined();
  });

  it("heartbeatOf returns the latest heartbeat for a run", async () => {
    const repo = new InMemoryScanStepRepository();
    await repo.markRunHeartbeat("run-1", "2026-01-01T00:00:00Z");
    expect(repo.heartbeatOf("run-1")).toBe("2026-01-01T00:00:00Z");
    expect(repo.heartbeatOf("run-unknown")).toBeUndefined();
  });
});

