import { describe, it, expect } from "vitest";
import { parseScanIntervalMinutes, waitForScanToSettle } from "../src/contexts/scanner/worker-runtime-helpers";

describe("parseScanIntervalMinutes", () => {
  const DEFAULT = 15;

  it("returns default for negative numbers", () => {
    expect(parseScanIntervalMinutes(-5, DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes(-0.1, DEFAULT)).toBe(DEFAULT);
  });

  it("returns default for non-finite values", () => {
    expect(parseScanIntervalMinutes(Infinity, DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes(-Infinity, DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes(NaN, DEFAULT)).toBe(DEFAULT);
  });

  it("returns default for empty string or garbage", () => {
    expect(parseScanIntervalMinutes("", DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes("garbage", DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes("15abc", DEFAULT)).toBe(DEFAULT);
  });

  it("returns default for 0 (falsy and not positive)", () => {
    expect(parseScanIntervalMinutes(0, DEFAULT)).toBe(DEFAULT);
    expect(parseScanIntervalMinutes("0", DEFAULT)).toBe(DEFAULT);
  });

  it("returns the valid positive number when provided as string or number", () => {
    expect(parseScanIntervalMinutes(10, DEFAULT)).toBe(10);
    expect(parseScanIntervalMinutes("10", DEFAULT)).toBe(10);
    expect(parseScanIntervalMinutes(0.5, DEFAULT)).toBe(0.5);
  });
});

describe("waitForScanToSettle", () => {
  it('returns "settled" when scanInFlight becomes false before timeout', async () => {
    let inFlight = true;
    let sleepCalls = 0;

    const sleep = async (ms: number) => {
      sleepCalls++;
      if (sleepCalls >= 2) {
        inFlight = false;
      }
    };

    const result = await waitForScanToSettle({
      scanInFlight: () => inFlight,
      pollMs: 100,
      timeoutMs: 1000,
      sleep,
    });

    expect(result).toBe("settled");
    expect(sleepCalls).toBe(2);
  });

  it('returns "timed_out" when it stays true past timeoutMs', async () => {
    let sleepCalls = 0;
    const sleep = async (ms: number) => {
      sleepCalls++;
    };

    const result = await waitForScanToSettle({
      scanInFlight: () => true,
      pollMs: 100,
      timeoutMs: 250,
      sleep,
    });

    expect(result).toBe("timed_out");
    // 250 / 100 = 2.5 -> 3 sleeps (100, 100, 50)
    expect(sleepCalls).toBe(3);
  });

  it("respects the injected sleep and does not over-poll", async () => {
    let sleepCalls = 0;
    const sleep = async (ms: number) => {
      sleepCalls++;
    };

    const result = await waitForScanToSettle({
      scanInFlight: () => true,
      pollMs: 50,
      timeoutMs: 120,
      sleep,
    });

    expect(result).toBe("timed_out");
    // 120 / 50 = 2.4 -> 3 sleeps (50, 50, 20)
    expect(sleepCalls).toBe(3);
  });
});
