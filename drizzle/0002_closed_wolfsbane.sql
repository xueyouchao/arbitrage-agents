ALTER TABLE "orderbook_snapshots" DROP CONSTRAINT "orderbook_yes_ask_range";--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" DROP CONSTRAINT "orderbook_no_ask_range";--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ALTER COLUMN "yes_ask" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ALTER COLUMN "no_ask" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "kalshi_orderbook_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "polymarket_orderbook_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD COLUMN "scan_run_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_kalshi_orderbook_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("kalshi_orderbook_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_polymarket_orderbook_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("polymarket_orderbook_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_snapshots_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_yes_ask_range" CHECK ("orderbook_snapshots"."yes_ask" is null or ("orderbook_snapshots"."yes_ask" > 0 and "orderbook_snapshots"."yes_ask" < 1));--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_no_ask_range" CHECK ("orderbook_snapshots"."no_ask" is null or ("orderbook_snapshots"."no_ask" > 0 and "orderbook_snapshots"."no_ask" < 1));