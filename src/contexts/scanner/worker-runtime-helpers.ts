// Pure runtime helpers for the production worker entry point.
//
// Kept dependency-free (no Nest / no repositories) so unit tests can import
// these without pulling the worker's full Nest dependency graph into coverage
// instrumentation. See src/main-worker.ts for the entry point that wires these
// into the scan loop and signal handlers.

export const DEFAULT_INTERVAL_MINUTES = 15;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// Parses WORKER_SCAN_INTERVAL_MINUTES (and WORKER_SHUTDOWN_TIMEOUT_MS) into a
// positive finite number, falling back to `defaultMinutes` for empty, garbage,
// non-finite, zero, or negative values. Guards against a misconfigured negative
// interval that would make `setTimeout` fire immediately and spin the worker
// in a tight scan loop.
export function parseScanIntervalMinutes(raw: unknown, defaultMinutes: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultMinutes;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMinutes;
  }
  return parsed;
}

export interface WaitForScanToSettleOptions {
  scanInFlight: () => boolean;
  pollMs?: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

// Polls `scanInFlight()` until it reports `false` (settled) or the configured
// `timeoutMs` budget is exhausted (timed_out). Elapsed time is accumulated from
// the durations passed to the injected `sleep` (not from the wall clock) so the
// function is deterministic under a no-op sleep stub in tests. The bounded
// timeout guarantees shutdown completes even if `runOnce()` hangs.
export async function waitForScanToSettle({
  scanInFlight,
  pollMs,
  timeoutMs,
  sleep,
}: WaitForScanToSettleOptions): Promise<"settled" | "timed_out"> {
  const pollInterval = pollMs ?? 500;
  let elapsed = 0;

  while (true) {
    if (!scanInFlight()) {
      return "settled";
    }

    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      return "timed_out";
    }

    const wait = Math.min(pollInterval, remaining);
    await sleep(wait);
    elapsed += wait;
  }
}