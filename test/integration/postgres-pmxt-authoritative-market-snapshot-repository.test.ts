import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresPmxtAuthoritativeMarketSnapshotRepository } from "../../src/contexts/scanner/pmxt/postgres-pmxt-authoritative-market-snapshot-repository";
import { DisposablePostgresDatabase, createDisposablePostgresDatabase } from "./postgres-test-database";

let db: DisposablePostgresDatabase;
let pool: Pool;
let repository: PostgresPmxtAuthoritativeMarketSnapshotRepository;

beforeEach(async () => {
  db = await createDisposablePostgresDatabase();
  await db.applyMigrations();
  pool = new Pool({ connectionString: db.databaseUrl });
  repository = new PostgresPmxtAuthoritativeMarketSnapshotRepository(pool);
});

afterEach(async () => {
  await pool?.end();
  await db?.close();
});

describe("PostgresPmxtAuthoritativeMarketSnapshotRepository integration", () => {
  it("returns envelope-unwrapped snapshots correlated to the requested scan", async () => {
    const firstScanId = "00000000-0000-4000-8000-000000000010";
    const secondScanId = "00000000-0000-4000-8000-000000000020";
    for (const id of [firstScanId, secondScanId]) {
      await db.query(
        `insert into scan_runs (id, status, started_at, completed_at, metrics)
         values ($1, 'succeeded', now(), now(), '{}'::jsonb)`,
        [id]
      );
    }
    await db.query(
      `insert into venue_market_snapshots
         (scan_run_id, venue, venue_market_id, raw_payload, captured_at)
       values
         ($1, 'kalshi', 'KXBTC', $3::jsonb, '2026-07-15T10:00:00Z'),
         ($2, 'polymarket', 'other-market', $4::jsonb, '2026-07-15T10:01:00Z')`,
      [
        firstScanId,
        secondScanId,
        JSON.stringify({
          scannerTitle: "Will BTC exceed $100k?",
          scannerRawResolutionText: "Resolves Yes above $100,000.",
          sourcePayload: { ticker: "KXBTC", yes_bid: 42 }
        }),
        JSON.stringify({
          scannerTitle: "Other market",
          scannerRawResolutionText: "Other rules",
          sourcePayload: { id: "other-market" }
        })
      ]
    );

    const snapshots = await repository.listByScanRunId(firstScanId);

    expect(snapshots).toEqual([
      {
        venue: "kalshi",
        venueMarketId: "KXBTC",
        title: "Will BTC exceed $100k?",
        rawResolutionText: "Resolves Yes above $100,000.",
        rawPayload: { ticker: "KXBTC", yes_bid: 42 },
        capturedAt: "2026-07-15T10:00:00.000Z"
      }
    ]);
  });
});
