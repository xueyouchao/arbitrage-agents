import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { WorkerScanRunner } from "./contexts/scanner/worker-scan-runner";

// Production worker entry point.
//
// Runs an infinite scan loop with a configurable interval between scans.
// The interval defaults to 15 minutes if WORKER_SCAN_INTERVAL_MINUTES
// is not set. Each scan iteration:
//   1. Detects and marks abandoned scans from prior crashes.
//   2. Executes a resumable scan (fetch → normalize → match → calculate).
//   3. Sleeps for the configured interval before the next iteration.
//
// The process handles SIGTERM/SIGINT gracefully: it waits for the
// current scan (if running) to complete before tearing down the
// application context and exiting, so the DB pool is not closed
// under an in-flight scan.

const DEFAULT_INTERVAL_MINUTES = 15;

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const runner = app.get(WorkerScanRunner);

  const intervalMinutes = Number(process.env.WORKER_SCAN_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES;
  const intervalMs = intervalMinutes * 60 * 1000;

  let shuttingDown = false;
  let scanInFlight = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] Received ${signal}, waiting for current scan to finish...`);
    // Wait for the in-flight scan (if any) to complete before tearing
    // down the application context. This prevents closing the DB pool
    // under an active scan, which would cause connection errors and
    // strand Sentry check-ins in "in_progress" state.
    while (scanInFlight) {
      await new Promise((r) => setTimeout(r, 500));
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
      // Poll shuttingDown every second so we wake quickly on SIGTERM/SIGINT
      // without needing temporary signal handlers. The main process.on
      // handlers (above) set shuttingDown = true, and this loop exits
      // within 1 second.
      const pollMs = 1000;
      const deadline = Date.now() + intervalMs;
      while (!shuttingDown && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }
}

void bootstrap();
