CREATE TABLE "paper_trade_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"simulated_at" timestamp with time zone NOT NULL,
	"target_notional_usd" numeric(18, 4) NOT NULL,
	"long_leg" jsonb NOT NULL,
	"hedge_leg" jsonb NOT NULL,
	"adverse_selection_bps" numeric(10, 4) NOT NULL,
	"partial_fill" boolean NOT NULL,
	"residual_exposure_usd" numeric(18, 4) NOT NULL,
	"combined_cost" numeric(18, 8) NOT NULL,
	"gross_edge" numeric(18, 8) NOT NULL,
	"net_edge" numeric(18, 8) NOT NULL,
	"config_version" text NOT NULL,
	"calculation_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "theoretical_combined_cost" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "theoretical_gross_edge" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "theoretical_net_edge" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "executable_size_usd" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "executable_combined_cost" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "executable_gross_edge" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "executable_net_edge" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN "first_detected_at" timestamp with time zone;--> statement-breakpoint
UPDATE "opportunities" SET "first_detected_at" = "detected_at" WHERE "first_detected_at" IS NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ALTER COLUMN "first_detected_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_trade_simulations" ADD CONSTRAINT "paper_trade_simulations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_trade_simulations_opportunity_simulated_at_idx" ON "paper_trade_simulations" USING btree ("opportunity_id","simulated_at");