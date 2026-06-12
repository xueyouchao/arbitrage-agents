ALTER TABLE "opportunities" ADD COLUMN "notional_edges" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "liquidity_risk" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "venue_risk" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "equivalence_risk" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "data_staleness_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "opportunity_age_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "calculation_version" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "config_version" text DEFAULT 'unknown' NOT NULL;