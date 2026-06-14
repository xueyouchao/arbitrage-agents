import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { opportunities } from "../src/db/schema";

describe("Phase 3 schema and migration", () => {
  it("defines opportunity Phase 3 columns with non-null defaults", () => {
    expect(opportunities.kalshiOrderbookSnapshotId.name).toBe("kalshi_orderbook_snapshot_id");
    expect(opportunities.polymarketOrderbookSnapshotId.name).toBe("polymarket_orderbook_snapshot_id");
    expect(opportunities.notionalEdges).toMatchObject({ name: "notional_edges", notNull: true, hasDefault: true });
    expect(opportunities.liquidityRisk).toMatchObject({ name: "liquidity_risk", notNull: true, hasDefault: true, default: "high" });
    expect(opportunities.venueRisk).toMatchObject({ name: "venue_risk", notNull: true, hasDefault: true, default: "high" });
    expect(opportunities.equivalenceRisk).toMatchObject({ name: "equivalence_risk", notNull: true, hasDefault: true, default: "high" });
    expect(opportunities.dataStalenessMs).toMatchObject({ name: "data_staleness_ms", notNull: true, hasDefault: true, default: 0 });
    expect(opportunities.opportunityAgeMs).toMatchObject({ name: "opportunity_age_ms", notNull: true, hasDefault: true, default: 0 });
    expect(opportunities.calculationVersion).toMatchObject({ name: "calculation_version", notNull: true, hasDefault: true, default: "unknown" });
    expect(opportunities.configVersion).toMatchObject({ name: "config_version", notNull: true, hasDefault: true, default: "unknown" });
  });

  it("adds the Phase 3 opportunity columns and defaults in migration 0006", () => {
    const sql = readFileSync(resolve(process.cwd(), "drizzle/0006_overconfident_owl.sql"), "utf8");

    expect(sql).toContain('ADD COLUMN "notional_edges" jsonb DEFAULT \'[]\'::jsonb NOT NULL');
    expect(sql).toContain('ADD COLUMN "liquidity_risk" text DEFAULT \'high\' NOT NULL');
    expect(sql).toContain('ADD COLUMN "venue_risk" text DEFAULT \'high\' NOT NULL');
    expect(sql).toContain('ADD COLUMN "equivalence_risk" text DEFAULT \'high\' NOT NULL');
    expect(sql).toContain('ADD COLUMN "data_staleness_ms" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('ADD COLUMN "opportunity_age_ms" integer DEFAULT 0 NOT NULL');
    expect(sql).toContain('ADD COLUMN "calculation_version" text DEFAULT \'unknown\' NOT NULL');
    expect(sql).toContain('ADD COLUMN "config_version" text DEFAULT \'unknown\' NOT NULL');
  });

  it("defensively deduplicates scan_steps before creating the unique index in migration 0008", () => {
    const sql = readFileSync(resolve(process.cwd(), "drizzle/0008_fix_scan_steps_attempt_uniqueness.sql"), "utf8");

    expect(sql).toContain('DELETE FROM "scan_steps"');
    expect(sql).toContain('PARTITION BY "scan_run_id", "step_name", "attempt"');
    expect(sql).toContain('CREATE UNIQUE INDEX "scan_steps_run_name_attempt_unique" ON "scan_steps"');
  });
});
