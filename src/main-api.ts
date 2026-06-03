import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiAppModule } from "./api-app.module";
import { APP_CONFIG } from "./config/config.module";
import { AppConfig } from "./config/app-config";

async function bootstrap() {
  const app = await NestFactory.create(ApiAppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}

void bootstrap();
