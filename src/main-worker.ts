import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { WorkerScanRunner } from "./contexts/scanner/worker-scan-runner";
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parseScanIntervalMinutes,
  parsePositiveFiniteNumber,
  waitForScanToSettle,
  createInterruptibleSleep,
} from "./contexts/scanner/worker-runtime-helpers";

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
//
// The interval parsing and shutdown/sleep helpers live in
// ./contexts/scanner/worker-runtime-helpers so they can be unit-tested
// without importing this entry point (which would pull the Nest
// dependency graph into coverage instrumentation).
//
// Signal handling: there is exactly ONE persistent shutdown handler per
// signal (process.on("SIGTERM"/"SIGINT") below). The interval sleep is
// interruptible via a transient listener (added/removed per sleep by
// createInterruptibleSleep) that ONLY resolves the sleep — it does not
// call shutdown. The persistent handler owns shutdown; the transient
// listener just lets the sleep end promptly so the loop re-checks
// `shuttingDown` and exits. This split is explicit and scoped, not
// accidental duplication.

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const runner = app.get(WorkerScanRunner);

  const intervalMinutes = parseScanIntervalMinutes(
    process.env.WORKER_SCAN_INTERVAL_MINUTES,
    DEFAULT_INTERVAL_MINUTES,
  );
  const intervalMs = intervalMinutes * 60 * 1000;

  // The shutdown timeout is in milliseconds — parse it with the generic
  // positive-finite helper, NOT the minutes-named one, so the value is
  // not misread as minutes (e.g. WORKER_SHUTDOWN_TIMEOUT_MS=60000 means
  // 60 seconds, not 60000 minutes).
  const shutdownTimeoutMs = parsePositiveFiniteNumber(
    process.env.WORKER_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );

  const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Interruptible interval sleep backed by real timers and real process
  // listeners. The transient listener added per sleep only resolves the
  // sleep; it does NOT call shutdown (the persistent handler does).
  const interruptibleSleep = createInterruptibleSleep({
    sleep: realSleep,
    addSignalListener: (sig, cb) => process.on(sig, cb),
    removeSignalListener: (sig, cb) => process.removeListener(sig, cb),
  });

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

  // One persistent shutdown handler per signal.
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
      // The transient listener inside interruptibleSleep resolves the sleep
      // on signal; the loop condition `!shuttingDown` then exits because the
      // persistent shutdown handler already set the flag.
      await interruptibleSleep(intervalMs);
    }
  }
}

// Only start the worker when this module is the process entry point, so
// importing the helpers from tests does not trigger Nest application
// bootstrap (which would require live env/config and crash the test worker).
if (require.main === module) {
  void bootstrap();
}