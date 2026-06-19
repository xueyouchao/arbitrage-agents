// Pure runtime helpers for the production worker entry point.
//
// Kept dependency-free (no Nest / no repositories) so unit tests can import
// these without pulling the worker's full Nest dependency graph into coverage
// instrumentation. See src/main-worker.ts for the entry point that wires these
// into the scan loop and signal handlers.

export const DEFAULT_INTERVAL_MINUTES = 15;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// Lower bound for the scan interval. A misconfigured WORKER_SCAN_INTERVAL_MINUTES
// such as 0.001 or 0.1 produces a very short interval (60 ms / 6 s) that makes the
// worker run scans in a tight loop, hammering the database and external APIs and
// consuming excessive CPU/RAM on the VPS. Anything below this floor is clamped up
// to it. (PR #27 review: "Unbounded scan interval".)
export const MIN_SCAN_INTERVAL_MINUTES = 1;

// Upper bound for the scan interval. A huge interval makes the worker effectively
// idle and is almost certainly a misconfiguration (e.g. units confusion). Anything
// above this ceiling is clamped down to it. 24 hours is a generous, safe cap.
export const MAX_SCAN_INTERVAL_MINUTES = 1440;

// Parses a generic positive finite number from an unknown raw value, falling
// back to `defaultValue` for empty, garbage, non-finite, zero, or negative
// values. Used for both minutes and milliseconds configuration so millisecond
// values are never routed through a minutes-named function.
export function parsePositiveFiniteNumber(raw: unknown, defaultValue: number): number {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

// Parses WORKER_SCAN_INTERVAL_MINUTES into a positive finite number, falling
// back to `defaultMinutes` for empty, garbage, non-finite, zero, or negative
// values. Guards against a misconfigured negative interval that would make
// `setTimeout` fire immediately and spin the worker in a tight scan loop.
//
// The result is clamped to [MIN_SCAN_INTERVAL_MINUTES, MAX_SCAN_INTERVAL_MINUTES]
// so a small positive value like 0.001 (60 ms) or 0.1 (6 s) cannot drive a tight
// scan loop, and an absurdly large value cannot effectively silence the worker.
// `defaultMinutes` itself is also clamped, so a misconfigured default cannot
// bypass the bounds.
export function parseScanIntervalMinutes(raw: unknown, defaultMinutes: number): number {
  const parsed = parsePositiveFiniteNumber(raw, defaultMinutes);
  return Math.min(Math.max(parsed, MIN_SCAN_INTERVAL_MINUTES), MAX_SCAN_INTERVAL_MINUTES);
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

export interface CreateInterruptibleSleepOptions {
  sleep: (ms: number) => Promise<void>;
  addSignalListener: (sig: "SIGTERM" | "SIGINT", cb: () => void) => void;
  removeSignalListener: (sig: "SIGTERM" | "SIGINT", cb: () => void) => void;
}

// Creates an interruptible sleep function. The returned function sleeps for `ms`
// and resolves "elapsed" on timeout, or "interrupted" if a signal callback fires.
// Signal listeners are registered via injected add/removeSignalListener so tests
// can pass stubs (no dependency on `process`). The helper guards against the
// sleep resolving AFTER an interrupt using an `interrupted` flag. It registers
// one transient listener per call (both SIGTERM and SIGINT point to the same
// interrupt callback) and removes them after firing or after the sleep elapses.
//
// The transient listener only resolves the sleep; it does NOT call shutdown.
// The persistent shutdown handler (registered once in bootstrap via process.on)
// owns shutdown — this is the explicit, scoped design, not accidental
// duplication.
export function createInterruptibleSleep(
  opts: CreateInterruptibleSleepOptions,
): (ms: number) => Promise<"elapsed" | "interrupted"> {
  return (ms: number) => {
    return new Promise<"elapsed" | "interrupted">((resolve) => {
      let interrupted = false;
      let settled = false;

      const cleanup = () => {
        opts.removeSignalListener("SIGTERM", interrupt);
        opts.removeSignalListener("SIGINT", interrupt);
      };

      const interrupt = () => {
        if (settled) return;
        settled = true;
        interrupted = true;
        cleanup();
        resolve("interrupted");
      };

      opts.addSignalListener("SIGTERM", interrupt);
      opts.addSignalListener("SIGINT", interrupt);

      opts.sleep(ms).then(() => {
        // Ignore the late sleep resolve if a signal already interrupted us.
        if (interrupted) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve("elapsed");
      });
    });
  };
}