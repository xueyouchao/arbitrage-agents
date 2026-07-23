-- PMXT equivalent-scope reads and anchored Router shadow persistence.
CREATE TABLE "pmxt_shadow_track_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "authoritative_scan_run_id" uuid NOT NULL,
  "shadow_run_id" uuid NOT NULL,
  "shadow_run_attempt_id" uuid NOT NULL,
  "track" text NOT NULL,
  "status" text NOT NULL,
  "cause" text NOT NULL,
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "authoritative_receipt_at" timestamp with time zone,
  "pmxt_receipt_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_track_runs" ADD CONSTRAINT "pmxt_shadow_track_runs_authoritative_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("authoritative_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pmxt_shadow_track_runs" ADD CONSTRAINT "pmxt_shadow_track_runs_shadow_run_attempt_id_pmxt_shadow_run_attempts_id_fk" FOREIGN KEY ("shadow_run_attempt_id") REFERENCES "public"."pmxt_shadow_run_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_track_runs_attempt_idx" ON "pmxt_shadow_track_runs" USING btree ("shadow_run_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_track_runs_attempt_track_unique" ON "pmxt_shadow_track_runs" USING btree ("shadow_run_attempt_id", "track");--> statement-breakpoint

CREATE TABLE "pmxt_shadow_markets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shadow_track_run_id" uuid NOT NULL,
  "catalog_market_id" text NOT NULL,
  "venue" text,
  "venue_native_id" text,
  "eligible" boolean NOT NULL,
  "exclusion_reason" text,
  "captured_at" timestamp with time zone NOT NULL,
  "payload" jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_markets" ADD CONSTRAINT "pmxt_shadow_markets_shadow_track_run_id_pmxt_shadow_track_runs_id_fk" FOREIGN KEY ("shadow_track_run_id") REFERENCES "public"."pmxt_shadow_track_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_markets_track_run_idx" ON "pmxt_shadow_markets" USING btree ("shadow_track_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_markets_track_catalog_unique" ON "pmxt_shadow_markets" USING btree ("shadow_track_run_id", "catalog_market_id");--> statement-breakpoint

CREATE TABLE "pmxt_shadow_router_clusters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shadow_track_run_id" uuid NOT NULL,
  "cluster_id" text NOT NULL,
  "payload" jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_router_clusters" ADD CONSTRAINT "pmxt_shadow_router_clusters_shadow_track_run_id_pmxt_shadow_track_runs_id_fk" FOREIGN KEY ("shadow_track_run_id") REFERENCES "public"."pmxt_shadow_track_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_router_clusters_track_run_idx" ON "pmxt_shadow_router_clusters" USING btree ("shadow_track_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_router_clusters_track_cluster_unique" ON "pmxt_shadow_router_clusters" USING btree ("shadow_track_run_id", "cluster_id");--> statement-breakpoint

CREATE TABLE "pmxt_shadow_router_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shadow_track_run_id" uuid NOT NULL,
  "cluster_id" text NOT NULL,
  "edge_ordinal" integer NOT NULL,
  "market_a_id" text NOT NULL,
  "market_b_id" text NOT NULL,
  "relation" text NOT NULL,
  "confidence" numeric NOT NULL,
  "eligible" boolean NOT NULL,
  "exclusion_reason" text,
  "kalshi_native_id" text,
  "polymarket_native_id" text,
  "payload" jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "pmxt_shadow_router_edges" ADD CONSTRAINT "pmxt_shadow_router_edges_shadow_track_run_id_pmxt_shadow_track_runs_id_fk" FOREIGN KEY ("shadow_track_run_id") REFERENCES "public"."pmxt_shadow_track_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pmxt_shadow_router_edges_track_run_idx" ON "pmxt_shadow_router_edges" USING btree ("shadow_track_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pmxt_shadow_router_edges_track_ordinal_unique" ON "pmxt_shadow_router_edges" USING btree ("shadow_track_run_id", "cluster_id", "edge_ordinal");
