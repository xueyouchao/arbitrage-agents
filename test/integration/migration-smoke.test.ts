import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { QueryResultRow } from "pg";
import { withDisposablePostgresDatabase } from "./postgres-test-database";

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
        "scan_runs",
        "scan_steps",
        "venue_market_snapshots"
      ]);

      await db.applyMigrations();
      await expect(tableNames(db.query.bind(db))).resolves.toEqual(firstTables);
    });
  });

  it("keeps scan_steps SQL migration and Drizzle snapshot aligned on indexes", async () => {
    const migrationSql = await readFile(join(process.cwd(), "drizzle/0006_phase4_resumable_worker.sql"), "utf8");
    const snapshot = JSON.parse(await readFile(join(process.cwd(), "drizzle/meta/0006_snapshot.json"), "utf8")) as {
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

  it("creates scan_steps without an accidental unique index on scan_run_id and step_name", async () => {
    await withDisposablePostgresDatabase(async (db) => {
      await db.applyMigrations();
      const indexes = await db.query<IndexRow>(
        `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'scan_steps' order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toContain("scan_steps_run_name_started_at_idx");
      expect(indexes.rows.some((row) => /unique/i.test(row.indexdef) && row.indexdef.includes("scan_run_id") && row.indexdef.includes("step_name"))).toBe(false);
    });
  });
});

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
