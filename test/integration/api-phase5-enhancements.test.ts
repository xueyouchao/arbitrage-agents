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

describe("Phase 5 API Enhancements", () => {
  describe("Pagination", () => {
    it("supports offset and limit for opportunities", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ offset: 0, limit: 2 })
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.offset).toBe(0);
      expect(response.body.pagination.limit).toBe(2);
      expect(response.body.pagination.total).toBeGreaterThanOrEqual(3);
      expect(response.body.data).toHaveLength(2);
    });

    it("supports pagination for markets", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/markets")
        .query({ offset: 0, limit: 1 })
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.offset).toBe(0);
      expect(response.body.pagination.limit).toBe(1);
      expect(response.body.data).toHaveLength(1);
    });

    it("respects default pagination limits", async () => {
      const oppResponse = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .expect(200);

      expect(oppResponse.body.pagination.limit).toBe(20);
      expect(oppResponse.body.pagination.offset).toBe(0);

      const marketResponse = await request(app.getHttpServer())
        .get("/v1/markets")
        .expect(200);

      expect(marketResponse.body.pagination.limit).toBe(50);
    });

    it("clamps limit to maximum allowed value", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ limit: 1000 })
        .expect(200);

      expect(response.body.pagination.limit).toBe(100);
    });

    it("indicates hasMore correctly", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ offset: 0, limit: 2 })
        .expect(200);

      expect(response.body.pagination.hasMore).toBe(true);

      const lastPageResponse = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ offset: 100, limit: 20 })
        .expect(200);

      expect(lastPageResponse.body.pagination.hasMore).toBe(false);
    });
  });

  describe("Filtering", () => {
    it("filters opportunities by equivalenceClass", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ equivalenceClass: "A" })
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((opp: any) => {
        expect(opp.equivalenceClass).toBe("A");
      });
    });

    it("filters opportunities by minNetEdge", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ minNetEdge: 0.05 })
        .expect(200);

      response.body.data.forEach((opp: any) => {
        expect(opp.netEdge).toBeGreaterThanOrEqual(0.05);
      });
    });

    it("filters opportunities by maxDataStalenessMs", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ maxDataStalenessMs: 10000 })
        .expect(200);

      response.body.data.forEach((opp: any) => {
        expect(opp.dataStalenessMs).toBeLessThanOrEqual(10000);
      });
    });

    it("filters opportunities by resolutionRisk", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ resolutionRisk: "low" })
        .expect(200);

      response.body.data.forEach((opp: any) => {
        expect(opp.resolutionRisk).toBe("low");
      });
    });

    it("filters opportunities by fillRisk", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ fillRisk: "medium" })
        .expect(200);

      response.body.data.forEach((opp: any) => {
        expect(opp.fillRisk).toBe("medium");
      });
    });

    it("filters opportunities by humanReviewFlag", async () => {
      const pendingResponse = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ humanReviewFlag: "pending" })
        .expect(200);

      expect(pendingResponse.body.data.length).toBeGreaterThan(0);
      pendingResponse.body.data.forEach((opp: any) => {
        expect(opp.humanReviewFlag).toBe("pending");
      });

      const approvedResponse = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ humanReviewFlag: "approved" })
        .expect(200);

      expect(approvedResponse.body.data.length).toBeGreaterThan(0);
      approvedResponse.body.data.forEach((opp: any) => {
        expect(opp.humanReviewFlag).toBe("approved");
      });
    });

    it("supports multiple filters combined", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ equivalenceClass: "A", resolutionRisk: "low", minNetEdge: 0.03 })
        .expect(200);

      response.body.data.forEach((opp: any) => {
        expect(opp.equivalenceClass).toBe("A");
        expect(opp.resolutionRisk).toBe("low");
        expect(opp.netEdge).toBeGreaterThanOrEqual(0.03);
      });
    });

    it("ignores invalid filter values", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ equivalenceClass: "X", minNetEdge: "invalid" })
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  describe("Sorting", () => {
    it("sorts opportunities by detectedAt descending by default", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .expect(200);

      const data = response.body.data;
      for (let i = 1; i < data.length; i++) {
        expect(new Date(data[i].detectedAt).getTime()).toBeLessThanOrEqual(
          new Date(data[i - 1].detectedAt).getTime()
        );
      }
    });

    it("sorts opportunities by netEdge ascending", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ sortBy: "netEdge", sortOrder: "asc" })
        .expect(200);

      const data = response.body.data;
      for (let i = 1; i < data.length; i++) {
        expect(data[i].netEdge).toBeGreaterThanOrEqual(data[i - 1].netEdge);
      }
    });

    it("sorts opportunities by opportunityAgeMs descending", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ sortBy: "opportunityAgeMs", sortOrder: "desc" })
        .expect(200);

      const data = response.body.data;
      for (let i = 1; i < data.length; i++) {
        expect(data[i].opportunityAgeMs).toBeLessThanOrEqual(data[i - 1].opportunityAgeMs);
      }
    });

    it("sorts opportunities by equivalenceClass", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .query({ sortBy: "equivalenceClass", sortOrder: "asc" })
        .expect(200);

      const data = response.body.data;
      for (let i = 1; i < data.length; i++) {
        expect(data[i].equivalenceClass >= data[i - 1].equivalenceClass).toBe(true);
      }
    });
  });

  describe("Human Review Flags", () => {
    it("exposes humanReviewFlag in opportunity response", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities/00000000-0000-4000-8000-000000000401")
        .expect(200);

      expect(response.body.humanReviewFlag).toBe("pending");
      expect(response.body.humanReviewNotes).toBe("Awaiting manual verification");
    });

    it("includes humanReviewFlag in list response", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .expect(200);

      const opportunity = response.body.data.find(
        (opp: any) => opp.id === "00000000-0000-4000-8000-000000000401"
      );
      expect(opportunity).toBeDefined();
      expect(opportunity.humanReviewFlag).toBe("pending");
      expect(opportunity.humanReviewNotes).toBe("Awaiting manual verification");
    });

    it("supports all human review flag values", async () => {
      const pending = await request(app.getHttpServer())
        .get("/v1/opportunities?humanReviewFlag=pending")
        .expect(200);
      expect(pending.body.data.length).toBeGreaterThan(0);

      const approved = await request(app.getHttpServer())
        .get("/v1/opportunities?humanReviewFlag=approved")
        .expect(200);
      expect(approved.body.data.length).toBeGreaterThan(0);

      const rejected = await request(app.getHttpServer())
        .get("/v1/opportunities?humanReviewFlag=rejected")
        .expect(200);
      expect(rejected.body.data.length).toBeGreaterThan(0);
    });
  });

  describe("Response Structure", () => {
    it("returns paginated response structure for opportunities", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/opportunities")
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("pagination");
      expect(response.body.pagination).toHaveProperty("offset");
      expect(response.body.pagination).toHaveProperty("limit");
      expect(response.body.pagination).toHaveProperty("total");
      expect(response.body.pagination).toHaveProperty("hasMore");
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it("returns paginated response structure for markets", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/markets")
        .expect(200);

      expect(response.body).toHaveProperty("data");
      expect(response.body).toHaveProperty("pagination");
      expect(response.body.pagination).toHaveProperty("offset");
      expect(response.body.pagination).toHaveProperty("limit");
      expect(response.body.pagination).toHaveProperty("total");
      expect(response.body.pagination).toHaveProperty("hasMore");
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });
});
