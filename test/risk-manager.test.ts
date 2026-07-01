import { describe, expect, it } from "vitest";
import { RiskManager } from "../src/contexts/execution/application/risk-manager";

describe("RiskManager", () => {
  it("rejects execution when total open notional + requested exceeds max capital deployed", () => {
    const guard = new RiskManager();
    // 4500 already deployed, requesting 600 → 5100 > 5000 → reject
    expect(guard.checkExecution(4500, 600, 5000)).toBe(false);
  });

  it("allows execution when total open notional + requested is within max capital deployed", () => {
    const guard = new RiskManager();
    // 4000 already deployed, requesting 1000 → 5000 == 5000 → allow
    expect(guard.checkExecution(4000, 1000, 5000)).toBe(true);
    // 3000 already deployed, requesting 500 → 3500 < 5000 → allow
    expect(guard.checkExecution(3000, 500, 5000)).toBe(true);
    // nothing deployed yet
    expect(guard.checkExecution(0, 5000, 5000)).toBe(true);
  });

  it("rejects when exactly at the boundary plus one", () => {
    const guard = new RiskManager();
    expect(guard.checkExecution(4999, 2, 5000)).toBe(false);
  });
});