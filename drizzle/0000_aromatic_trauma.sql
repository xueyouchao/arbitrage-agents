CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kalshi_market_id" uuid NOT NULL,
	"polymarket_market_id" uuid NOT NULL,
	"equivalence_class" text,
	"decision" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"parsed_output" jsonb,
	"status" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"estimated_cost_usd" numeric,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue" text NOT NULL,
	"venue_market_id" text NOT NULL,
	"title" text NOT NULL,
	"raw_resolution_text" text NOT NULL,
	"topic" text NOT NULL,
	"event_type" text NOT NULL,
	"asset" text,
	"threshold" numeric,
	"operator" text,
	"deadline" timestamp with time zone,
	"timezone" text,
	"resolution_source" text,
	"payoff_type" text NOT NULL,
	"ambiguity_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_pair_id" uuid NOT NULL,
	"long_leg" jsonb NOT NULL,
	"hedge_leg" jsonb NOT NULL,
	"combined_cost" numeric NOT NULL,
	"gross_edge" numeric NOT NULL,
	"estimated_fees" numeric NOT NULL,
	"estimated_slippage" numeric NOT NULL,
	"net_edge" numeric NOT NULL,
	"max_tradable_usd" numeric NOT NULL,
	"equivalence_class" text NOT NULL,
	"resolution_risk" text NOT NULL,
	"fill_risk" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orderbook_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_market_id" uuid NOT NULL,
	"yes_ask" numeric NOT NULL,
	"no_ask" numeric NOT NULL,
	"yes_available_usd" numeric NOT NULL,
	"no_available_usd" numeric NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	CONSTRAINT "orderbook_yes_ask_range" CHECK ("orderbook_snapshots"."yes_ask" > 0 and "orderbook_snapshots"."yes_ask" < 1),
	CONSTRAINT "orderbook_no_ask_range" CHECK ("orderbook_snapshots"."no_ask" > 0 and "orderbook_snapshots"."no_ask" < 1),
	CONSTRAINT "orderbook_yes_available_nonnegative" CHECK ("orderbook_snapshots"."yes_available_usd" >= 0),
	CONSTRAINT "orderbook_no_available_nonnegative" CHECK ("orderbook_snapshots"."no_available_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_market_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"venue" text NOT NULL,
	"venue_market_id" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_kalshi_market_id_normalized_markets_id_fk" FOREIGN KEY ("kalshi_market_id") REFERENCES "public"."normalized_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_pairs" ADD CONSTRAINT "candidate_pairs_polymarket_market_id_normalized_markets_id_fk" FOREIGN KEY ("polymarket_market_id") REFERENCES "public"."normalized_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_candidate_pair_id_candidate_pairs_id_fk" FOREIGN KEY ("candidate_pair_id") REFERENCES "public"."candidate_pairs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_snapshots_normalized_market_id_normalized_markets_id_fk" FOREIGN KEY ("normalized_market_id") REFERENCES "public"."normalized_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_market_snapshots" ADD CONSTRAINT "venue_market_snapshots_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_pairs_market_unique" ON "candidate_pairs" USING btree ("kalshi_market_id","polymarket_market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_evaluations_cache_unique" ON "llm_evaluations" USING btree ("input_hash","prompt_version","model");--> statement-breakpoint
CREATE UNIQUE INDEX "normalized_markets_venue_market_unique" ON "normalized_markets" USING btree ("venue","venue_market_id");