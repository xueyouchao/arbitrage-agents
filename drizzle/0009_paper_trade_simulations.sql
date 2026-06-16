-- Phase 3 #6: persist paper-trade simulation records alongside each
-- emitted opportunity. The simulator runs on every emitted opportunity
-- during the scan and produces one row per target notional. A record
-- holds the depth-walked fill for each leg, the combined edge after
-- fees/slippage/adverse-selection, the partial-fill flag, the residual
-- exposure USD, and the calculation/config version stamps. The cascade
-- delete on opportunity_id keeps audit history cleanly tied to its parent
-- opportunity; if the opportunity is dropped, its sims follow.
CREATE TABLE "paper_trade_simulations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
);--> statement-breakpoint

ALTER TABLE "paper_trade_simulations" ADD CONSTRAINT "paper_trade_simulations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Most reads are by opportunity, most-recent first (e.g. "show me the
-- sims for the latest opportunity"). A composite index supports the
-- (opportunity_id, simulated_at desc) access pattern without a sort.
CREATE INDEX "paper_trade_simulations_opportunity_simulated_at_idx" ON "paper_trade_simulations" USING btree ("opportunity_id","simulated_at");
