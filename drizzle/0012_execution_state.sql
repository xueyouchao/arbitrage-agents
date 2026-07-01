-- Issue #79: execution-state tables. Stores submitted orders (one row per
-- leg), realised fills, and cross-venue positions linking the two legs.
-- Positions in `partial` status are unwound by #80.
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric NOT NULL,
	"size" numeric NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"fill_price" numeric NOT NULL,
	"fill_size" numeric NOT NULL,
	"filled_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" text NOT NULL,
	"kalshi_order_id" uuid,
	"poly_order_id" uuid,
	"status" text NOT NULL,
	"pnl" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_kalshi_order_id_orders_id_fk" FOREIGN KEY ("kalshi_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_poly_order_id_orders_id_fk" FOREIGN KEY ("poly_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fills_order_id_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");