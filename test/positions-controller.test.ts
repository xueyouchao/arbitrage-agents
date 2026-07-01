import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionsController } from "../src/contexts/api/positions.controller";
import {
  POSITION_READ_REPOSITORY,
  PositionReadService,
  PositionReadModel,
  PositionReadRepository,
  CapitalUtilizationSummary
} from "../src/contexts/api/read-models";
import { APP_CONFIG } from "../src/config/config.module";

const mockConfig = { maxCapitalDeployedUsd: 5000 };

/**
 * In-memory position read repository for testing the PositionsController
 * without a real Postgres connection.
 */
function mockPositionRepository(
  positions: PositionReadModel[],
  summary: CapitalUtilizationSummary
): PositionReadRepository {
  return {
    listOpenPositions: vi.fn(async () => positions),
    getCapitalUtilization: vi.fn(async () => summary)
  };
}

describe("PositionsController", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function buildApp(positions: PositionReadModel[], summary: CapitalUtilizationSummary) {
    const repo = mockPositionRepository(positions, summary);
    const moduleRef = await Test.createTestingModule({
      controllers: [PositionsController],
      providers: [
        PositionReadService,
        { provide: POSITION_READ_REPOSITORY, useValue: repo },
        { provide: APP_CONFIG, useValue: mockConfig }
      ]
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  it("GET /v1/positions returns a JSON array of positions with id, status, venue, market, realizedPnl", async () => {
    const positions: PositionReadModel[] = [
      {
        id: "pos-1",
        opportunityId: "opp-1",
        status: "open",
        kalshiOrderId: "ord-k1",
        polyOrderId: "ord-p1",
        kalshiMarket: "KXBTC-100K",
        polymarketMarket: "token-123",
        kalshiVenue: "kalshi",
        polymarketVenue: "polymarket",
        notionalUsd: 1000,
        realizedPnl: 50,
        createdAt: "2026-07-01T00:00:00.000Z"
      },
      {
        id: "pos-2",
        opportunityId: "opp-2",
        status: "partial",
        kalshiOrderId: "ord-k2",
        polyOrderId: null,
        kalshiMarket: "KXETH-5K",
        polymarketMarket: null,
        kalshiVenue: "kalshi",
        polymarketVenue: null,
        notionalUsd: 500,
        realizedPnl: -20,
        createdAt: "2026-07-01T01:00:00.000Z"
      }
    ];

    await buildApp(positions, {
      totalOpenNotional: 1500,
      maxCapitalDeployed: 5000,
      utilizationPct: 30
    });

    const response = await request(app.getHttpServer()).get("/v1/positions").expect(200);

    expect(Array.isArray(response.body.positions)).toBe(true);
    expect(response.body.positions).toHaveLength(2);
    expect(response.body.positions[0]).toMatchObject({
      id: "pos-1",
      status: "open",
      kalshiMarket: "KXBTC-100K",
      polymarketMarket: "token-123",
      realizedPnl: 50
    });
    expect(response.body.positions[1]).toMatchObject({
      id: "pos-2",
      status: "partial",
      realizedPnl: -20
    });
  });

  it("GET /v1/positions includes capital utilization summary", async () => {
    await buildApp([], {
      totalOpenNotional: 3000,
      maxCapitalDeployed: 5000,
      utilizationPct: 60
    });

    const response = await request(app.getHttpServer()).get("/v1/positions").expect(200);

    expect(response.body.capitalUtilization).toMatchObject({
      totalOpenNotional: 3000,
      maxCapitalDeployed: 5000,
      utilizationPct: 60
    });
  });

  it("returns an empty positions array when no open positions exist", async () => {
    await buildApp([], {
      totalOpenNotional: 0,
      maxCapitalDeployed: 5000,
      utilizationPct: 0
    });

    const response = await request(app.getHttpServer()).get("/v1/positions").expect(200);

    expect(response.body.positions).toEqual([]);
    expect(response.body.capitalUtilization.utilizationPct).toBe(0);
  });
});