import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { PmxtShadowRunner } from "./contexts/scanner/pmxt/pmxt-shadow-runner";
import { PMXT_SHADOW_RUNNER } from "./contexts/scanner/scanner-tokens";

// Issue #93: separate PMXT shadow evaluation entry point.
//
// This process claims the oldest eligible unclaimed authoritative scan,
// runs a bounded PMXT shadow read/Router comparison against it, and persists
// only to dedicated shadow tables. It never starts the authoritative
// WorkerScanRunner or writes to production candidate/opportunity/alert tables.
//
// The process exits without network calls when PMXT shadowing is disabled,
// matching the plan's fail-closed default.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const runner = app.get<PmxtShadowRunner | undefined>(PMXT_SHADOW_RUNNER);

  if (!runner) {
    console.log("[pmxt-shadow] PMXT shadowing is disabled; exiting.");
    await app.close();
    process.exit(0);
  }

  console.log("[pmxt-shadow] Starting one shadow run.");
  const result = await runner.runOnce();
  console.log(`[pmxt-shadow] Run completed: ${JSON.stringify(result)}`);

  await app.close();
  process.exit(0);
}

if (require.main === module) {
  void bootstrap().catch(async (error) => {
    console.error("[pmxt-shadow] Fatal error:", error);
    process.exit(1);
  });
}
