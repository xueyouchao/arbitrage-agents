// test/main-worker.test.ts
import { describe, it, expect } from "vitest";
import {
  parseScanIntervalMinutes,
  parsePositiveFiniteNumber,
  waitForScanToSettle,
  createInterruptibleSleep,
} from "../src/contexts/scanner/worker-runtime-helpers";

describe("parsePositiveFiniteNumber", () => {
  const DEFAULT = 30000;
  it("returns default for negative numbers", () => {
    expect(parsePositiveFiniteNumber(-5, DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber(-0.1, DEFAULT)).toBe(DEFAULT);
  });
  it("returns default for non-finite values", () => {
    expect(parsePositiveFiniteNumber(Infinity, DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber(-Infinity, DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber(NaN, DEFAULT)).toBe(DEFAULT);
  });
  it("returns default for empty string or garbage", () => {
    expect(parsePositiveFiniteNumber("", DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber("garbage", DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber("15abc", DEFAULT)).toBe(DEFAULT);
  });
  it("returns default for 0 (falsy and not positive)", () => {
    expect(parsePositiveFiniteNumber(0, DEFAULT)).toBe(DEFAULT);
    expect(parsePositiveFiniteNumber("0", DEFAULT)).toBe(DEFAULT);
  });
  it("returns the valid positive number when provided as string or number", () => {
    expect(parsePositiveFiniteNumber(10, DEFAULT)).toBe(10);
    expect(parsePositiveFiniteNumber("10", DEFAULT)).toBe(10);
    expect(parsePositiveFiniteNumber(0.5, DEFAULT)).toBe(0.5);
  });
});

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
    const sleep = async (ms: number) => { sleepCalls++; if (sleepCalls >= 2) inFlight = false; };
    const result = await waitForScanToSettle({ scanInFlight: () => inFlight, pollMs: 100, timeoutMs: 1000, sleep });
    expect(result).toBe("settled");
    expect(sleepCalls).toBe(2);
  });
  it('returns "timed_out" when it stays true past timeoutMs', async () => {
    let sleepCalls = 0;
    const sleep = async (ms: number) => { sleepCalls++; };
    const result = await waitForScanToSettle({ scanInFlight: () => true, pollMs: 100, timeoutMs: 250, sleep });
    expect(result).toBe("timed_out");
    expect(sleepCalls).toBe(3);
  });
  it("respects the injected sleep and does not over-poll", async () => {
    let sleepCalls = 0;
    const sleep = async (ms: number) => { sleepCalls++; };
    const result = await waitForScanToSettle({ scanInFlight: () => true, pollMs: 50, timeoutMs: 120, sleep });
    expect(result).toBe("timed_out");
    expect(sleepCalls).toBe(3);
  });
});

describe("createInterruptibleSleep", () => {
  const setupFakes = () => {
    const listeners: Record<string, Array<() => void>> = { SIGTERM: [], SIGINT: [] };
    const sleepResolvers: Array<() => void> = [];
    
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      sleepResolvers.push(resolve);
    });

    const addSignalListener = (sig: "SIGTERM" | "SIGINT", cb: () => void) => {
      listeners[sig].push(cb);
    };

    const removeSignalListener = (sig: "SIGTERM" | "SIGINT", cb: () => void) => {
      listeners[sig] = listeners[sig].filter((fn) => fn !== cb);
    };

    return { listeners, sleepResolvers, sleep, addSignalListener, removeSignalListener };
  };

  it('resolves "elapsed" when the sleep completes with no signal', async () => {
    const { listeners, sleepResolvers, sleep, addSignalListener, removeSignalListener } = setupFakes();
    const interruptibleSleep = createInterruptibleSleep({ sleep, addSignalListener, removeSignalListener });
    
    const promise = interruptibleSleep(1000);
    
    expect(listeners.SIGTERM.length).toBe(1);
    expect(listeners.SIGINT.length).toBe(1);
    
    sleepResolvers[0](); // Resolve sleep
    const result = await promise;
    
    expect(result).toBe("elapsed");
    expect(listeners.SIGTERM.length).toBe(0);
    expect(listeners.SIGINT.length).toBe(0);
  });

  it('resolves "interrupted" and removes the listener when a signal callback fires before the sleep elapses', async () => {
    const { listeners, sleepResolvers, sleep, addSignalListener, removeSignalListener } = setupFakes();
    const interruptibleSleep = createInterruptibleSleep({ sleep, addSignalListener, removeSignalListener });
    
    const promise = interruptibleSleep(1000);
    
    expect(listeners.SIGTERM.length).toBe(1);
    expect(listeners.SIGINT.length).toBe(1);
    
    listeners.SIGTERM[0](); // Fire signal
    
    const result = await promise;
    expect(result).toBe("interrupted");
    
    expect(listeners.SIGTERM.length).toBe(0);
    expect(listeners.SIGINT.length).toBe(0);
    
    sleepResolvers[0](); // Resolve sleep late, should be ignored
    await new Promise((r) => setImmediate(r));
  });

  it('does not leave listeners registered after elapsed', async () => {
    const { listeners, sleepResolvers, sleep, addSignalListener, removeSignalListener } = setupFakes();
    const interruptibleSleep = createInterruptibleSleep({ sleep, addSignalListener, removeSignalListener });
    
    const promise = interruptibleSleep(1000);
    sleepResolvers[0]();
    await promise;
    
    expect(listeners.SIGTERM.length).toBe(0);
    expect(listeners.SIGINT.length).toBe(0);
  });

  it('does not leave listeners registered after interrupted', async () => {
    const { listeners, sleep, addSignalListener, removeSignalListener } = setupFakes();
    const interruptibleSleep = createInterruptibleSleep({ sleep, addSignalListener, removeSignalListener });
    
    const promise = interruptibleSleep(1000);
    listeners.SIGINT[0](); // Fire signal
    await promise;
    
    expect(listeners.SIGTERM.length).toBe(0);
    expect(listeners.SIGINT.length).toBe(0);
  });
});
