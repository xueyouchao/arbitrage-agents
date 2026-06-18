import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { QueryResultRow } from "pg";
import { DisposablePostgresDatabase, withDisposablePostgresDatabase } from "./postgres-test-database";

interface IndexRow {
  indexname: string;
  indexdef: string;
}

interface TableRow {
  table_name: string;
}

describe("migration smoke tests", () => {
  it("applies all checked-in migrations to a fresh Postgres database and is idempotent", async () => {
    await withDisposablePostgresDatabase(async (db) => {
      await db.applyMigrations();
      const firstTables = await tableNames(db.query.bind(db));
      expect(firstTables).toEqual([
        "alerts",
        "candidate_pairs",
        "llm_evaluations",
        "normalized_markets",
        "opportunities",
        "orderbook_snapshots",
        "paper_trade_simulations",
        "scan_runs",
        "scan_steps",
        "venue_market_snapshots"
      ]);

      await db.applyMigrations();
      await expect(tableNames(db.query.bind(db))).resolves.toEqual(firstTables);
    });
  });

  it("keeps scan_steps SQL migration and Drizzle snapshot aligned on indexes", async () => {
    // The Phase 4 scan_steps migration was renamed from 0006 to 0007 on this branch
    // (because Phase 3's 0006_overconfident_owl takes idx 6 here). The unique index
    // added by the 0008_fix_scan_steps_attempt_uniqueness migration lives outside the
    // 0007 snapshot, so the assertion below deliberately excludes it.
    const migrationSql = await readFile(join(process.cwd(), "drizzle/0007_phase4_resumable_worker.sql"), "utf8");
    const snapshot = JSON.parse(await readFile(join(process.cwd(), "drizzle/meta/0007_snapshot.json"), "utf8")) as {
      tables: Record<string, { indexes?: Record<string, { isUnique: boolean }> }>;
    };

    const snapshotIndexes = snapshot.tables["public.scan_steps"]?.indexes ?? {};
    const snapshotIndexNames = Object.keys(snapshotIndexes).sort();
    const migrationIndexNames = [...migrationSql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "scan_steps"/g)]
      .map((match) => match[1])
      .sort();

    expect(snapshotIndexNames).toEqual(migrationIndexNames);
    expect(Object.entries(snapshotIndexes).filter(([, index]) => index.isUnique).map(([name]) => name)).toEqual([]);
  });

  it("creates the intended unique index on scan_run_id, step_name, attempt and tolerates pre-existing duplicates", async () => {
    await withDisposablePostgresDatabase(async (db) => {
      await applyMigrationsUpTo("0007_phase4_resumable_worker", db);

      const runId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const stepName = "detect-opportunities";
      await db.query(
        `INSERT INTO "scan_runs" ("id", "status", "started_at") VALUES ($1, $2, now())`,
        [runId, "running"]
      );

      const earlier = new Date(Date.now() - 10_000).toISOString();
      const later = new Date().toISOString();
      const tieStepName = "fetch-orderbooks";
      const tieTime = new Date(Date.now() - 5_000).toISOString();
      const lowerId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10";
      const higherId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
      await db.query(
        `INSERT INTO "scan_steps" ("id", "scan_run_id", "step_name", "status", "attempt", "started_at")
         VALUES (gen_random_uuid(), $1, $2, $3, 1, $4::timestamptz),
                (gen_random_uuid(), $1, $2, $3, 1, $5::timestamptz),
                ($6, $1, $7, $3, 1, $8::timestamptz),
                ($9, $1, $7, $3, 1, $8::timestamptz)`,
        [runId, stepName, "completed", earlier, later, lowerId, tieStepName, tieTime, higherId]
      );

      const before = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM "scan_steps" WHERE "scan_run_id" = $1`,
        [runId]
      );
      expect(before.rows[0].count).toBe(4);

      await applyMigrationFile("0008_fix_scan_steps_attempt_uniqueness", db);

      const afterTimed = await db.query<{ count: number; started_at: string }>(
        `SELECT COUNT(*)::int as count, MAX("started_at") as started_at
         FROM "scan_steps" WHERE "scan_run_id" = $1 AND "step_name" = $2`,
        [runId, stepName]
      );
      expect(afterTimed.rows[0].count).toBe(1);
      expect(new Date(afterTimed.rows[0].started_at).toISOString()).toBe(later);

      const afterTie = await db.query<{ count: number; id: string }>(
        `SELECT COUNT(*)::int as count, "id" FROM "scan_steps"
         WHERE "scan_run_id" = $1 AND "step_name" = $2
         GROUP BY "id"`,
        [runId, tieStepName]
      );
      expect(afterTie.rows[0].count).toBe(1);
      expect(afterTie.rows[0].id).toBe(higherId);

      const indexes = await db.query<IndexRow>(
        `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'scan_steps' order by indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain("scan_steps_run_name_started_at_idx");
      const uniqueIndex = indexes.rows.find(
        (row) => /unique/i.test(row.indexdef) && row.indexdef.includes("scan_run_id") && row.indexdef.includes("step_name") && row.indexdef.includes("attempt")
      );
      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex!.indexdef).toContain("scan_steps_run_name_attempt_unique");

      await expect(
        db.query(
          `INSERT INTO "scan_steps" ("scan_run_id", "step_name", "status", "attempt", "started_at")
           VALUES ($1, $2, $3, 1, now())`,
          [runId, stepName, "completed"]
        )
      ).rejects.toThrow(/unique/i);
    });
  });
});

async function applyMigrationsUpTo(tag: string, db: DisposablePostgresDatabase): Promise<void> {
  const journal = JSON.parse(await readFile(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    await applyMigrationFile(entry.tag, db);
    if (entry.tag === tag) break;
  }
}

async function applyMigrationFile(tag: string, db: DisposablePostgresDatabase): Promise<void> {
  const sql = await readFile(join(process.cwd(), `drizzle/${tag}.sql`), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}

async function tableNames(query: <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>): Promise<string[]> {
  const result = await query<TableRow>(
    `select table_name
     from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
       and table_name not like 'drizzle_%'
     order by table_name`
  );
  return result.rows.map((row) => row.table_name);
}
