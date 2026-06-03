import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerAppModule } from "./worker-app.module";
import { WorkerScanRunner } from "./contexts/scanner/worker-scan-runner";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  try {
    await app.get(WorkerScanRunner).runOnce();
  } finally {
    await app.close();
  }
}

void bootstrap();
