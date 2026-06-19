import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { WorkerScanRunner } from "./contexts/scanner/worker-scan-runner";

// Production worker entry point.
//
// Runs an infinite scan loop with a configurable interval between scans.
// The interval defaults to 15 minutes if WORKER_SCAN_INTERVAL_MINUTES
// is not set or is misconfigured to a non-positive / non-finite value.
// Each scan iteration:
//   1. Detects and marks abandoned scans from prior crashes.
//   2. Executes a resumable scan (fetch → normalize → match → calculate).
//   3. Sleeps for the configured interval before the next iteration.
//
// The process handles SIGTERM/SIGINT gracefully: it waits for the
// current scan (if running) to complete before tearing down the
// application context and exiting, so the DB pool is not closed
// under an in-flight scan. The wait is bounded by
// WORKER_SHUTDOWN_TIMEOUT_MS (default 30s): if the in-flight scan has
// not finished by the deadline, shutdown proceeds anyway so the worker
// exits within Docker's stop grace period rather than being
// force-killed (which would strand DB connections and Sentry check-ins).

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

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

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const runner = app.get(WorkerScanRunner);

  const intervalMinutes = parseScanIntervalMinutes(
    process.env.WORKER_SCAN_INTERVAL_MINUTES,
    DEFAULT_INTERVAL_MINUTES,
  );
  const intervalMs = intervalMinutes * 60 * 1000;

  const shutdownTimeoutMs = parseScanIntervalMinutes(
    process.env.WORKER_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );

  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  let shuttingDown = false;
  let scanInFlight = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] Received ${signal}, waiting for current scan to finish...`);
    // Wait for the in-flight scan (if any) to complete before tearing
    // down the application context, but only up to `shutdownTimeoutMs`.
    // This prevents closing the DB pool under an active scan while still
    // bounding shutdown so the worker is not force-killed past Docker's
    // stop grace if `runOnce()` hangs.
    const outcome = await waitForScanToSettle({
      scanInFlight: () => scanInFlight,
      pollMs: 500,
      timeoutMs: shutdownTimeoutMs,
      sleep: realSleep,
    });

    if (outcome === "timed_out") {
      console.warn(
        `[worker] In-flight scan did not finish within ${shutdownTimeoutMs}ms; proceeding with shutdown anyway.`,
      );
    }

    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(`[worker] Starting scan loop (interval: ${intervalMinutes} min)`);

  while (!shuttingDown) {
    try {
      scanInFlight = true;
      console.log(`[worker] Starting scan at ${new Date().toISOString()}`);
      await runner.runOnce();
      console.log(`[worker] Scan completed successfully`);
    } catch (error) {
      console.error(`[worker] Scan failed:`, error);
    } finally {
      scanInFlight = false;
    }

    if (!shuttingDown) {
      console.log(`[worker] Sleeping ${intervalMinutes} min until next scan...`);
      await new Promise<void>((resolve) => {
        const onTerm = () => { clearTimeout(timer); resolve(); };
        const onInt  = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          process.removeListener("SIGTERM", onTerm);
          process.removeListener("SIGINT", onInt);
          resolve();
        }, intervalMs);
        process.once("SIGTERM", onTerm);
        process.once("SIGINT", onInt);
      });
    }
  }
}

// Only start the worker when this module is the process entry point, so
// importing the helpers from tests does not trigger Nest application
// bootstrap (which would require live env/config and crash the test worker).
if (require.main === module) {
  void bootstrap();
}