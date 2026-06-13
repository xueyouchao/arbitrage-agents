import "reflect-metadata";
import { readFile } from "fs/promises";
import { join } from "path";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiAppModule } from "../../src/api-app.module";
import { DisposablePostgresDatabase, createDisposablePostgresDatabase } from "./postgres-test-database";

let db: DisposablePostgresDatabase;
let app: INestApplication;
let originalDatabaseUrl: string | undefined;
let originalNodeEnv: string | undefined;

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();
  const seedSql = await readFile(join(process.cwd(), "test/acceptance/seed.sql"), "utf8");
  await db.query(seedSql);

  originalDatabaseUrl = process.env.DATABASE_URL;
  originalNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.NODE_ENV = "test";

  const moduleRef = await Test.createTestingModule({ imports: [ApiAppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterEach(async () => {
  await app?.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  await db?.close();
});

describe("API + Postgres integration", () => {
  it("serves seeded read models from Postgres", async () => {
    await request(app.getHttpServer()).get("/health").expect(200).expect({ status: "ok" });

    const markets = await request(app.getHttpServer()).get("/v1/markets").expect(200);
    expect(markets.body).toHaveLength(2);
    expect(markets.body[0]).toMatchObject({
      venue: "polymarket",
      venueMarketId: "P1",
      threshold: 100000,
      confidence: 0.93
    });

    const opportunities = await request(app.getHttpServer()).get("/v1/opportunities").expect(200);
    expect(opportunities.body).toHaveLength(1);
    expect(opportunities.body[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000401",
      pairId: "00000000-0000-4000-8000-000000000201",
      combinedCost: 0.93,
      netEdge: 0.055,
      kalshiOrderbookSnapshotId: "00000000-0000-4000-8000-000000000301",
      polymarketOrderbookSnapshotId: "00000000-0000-4000-8000-000000000302"
    });

    const opportunity = await request(app.getHttpServer())
      .get("/v1/opportunities/00000000-0000-4000-8000-000000000401")
      .expect(200);
    expect(opportunity.body).toMatchObject({
      maxTradableUsd: 12,
      resolutionRisk: "low",
      fillRisk: "medium",
      detectedAt: "2026-06-03T12:00:01.000Z"
    });

    const latestScanRun = await request(app.getHttpServer()).get("/v1/scan-runs/latest").expect(200);
    expect(latestScanRun.body).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      status: "succeeded",
      marketsScanned: 2,
      opportunitiesFound: 1
    });
  });

  it("keeps API error contracts stable", async () => {
    const malformed = await request(app.getHttpServer()).get("/v1/opportunities/not-a-uuid").expect(400);
    expect(malformed.body.message).toBe("Opportunity id must be a UUID");

    const missing = await request(app.getHttpServer())
      .get("/v1/opportunities/00000000-0000-4000-8000-000000009999")
      .expect(404);
    expect(missing.body.message).toBe("Opportunity 00000000-0000-4000-8000-000000009999 not found");
  });
});
