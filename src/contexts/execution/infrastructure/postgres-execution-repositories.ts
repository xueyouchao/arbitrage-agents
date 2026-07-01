import type { Pool } from "pg";
import type {
  ExecutionRepositories,
  RecordedFill,
  RecordedOrder,
  RecordedPosition
} from "../application/execution-orchestrator";

/**
 * Drizzle/`pg`-backed implementation of `ExecutionRepositories`. The
 * orchestrator writes orders, fills, and positions through this sink in
 * production. Each insert maps to a single `INSERT ... RETURNING` so the
 * returned row carries the DB-generated id.
 *
 * Kept deliberately thin — the orchestrator owns all decision logic; this
 * class only persists what it's handed.
 *
 * NOTE: This class accepts a `pg.Pool` in its constructor. The runbook
 * (`runbook/execute.ts`) creates its own Pool and is responsible for
 * closing it. When the execution module is wired into the NestJS app,
 * pass the shared `DATABASE_POOL` from `src/db/database-pool.ts` instead
 * of constructing a new pool — the NestJS lifecycle owns that pool's
 * teardown, not this class.
 */
export class PostgresExecutionRepositories implements ExecutionRepositories {
  constructor(private readonly pool: Pool) {}

  orders = {
    insert: async (row: {
      venue: string;
      market: string;
      side: string;
      price: string;
      size: string;
      status: string;
    }): Promise<RecordedOrder> => {
      const result = await this.pool.query(
        `insert into orders (venue, market, side, price, size, status)
         values ($1, $2, $3, $4, $5, $6)
         returning id, venue, market, side, price::text as price, size::text as size, status`,
        [row.venue, row.market, row.side, row.price, row.size, row.status]
      );
      const r = result.rows[0];
      return {
        id: String(r.id),
        venue: r.venue,
        market: r.market,
        side: r.side,
        price: r.price,
        size: r.size,
        status: r.status
      };
    }
  };

  fills = {
    insert: async (row: {
      orderId: string;
      fillPrice: string;
      fillSize: string;
    }): Promise<RecordedFill> => {
      const result = await this.pool.query(
        `insert into fills (order_id, fill_price, fill_size)
         values ($1, $2, $3)
         returning id, order_id::text as order_id, fill_price::text as fill_price, fill_size::text as fill_size`,
        [row.orderId, row.fillPrice, row.fillSize]
      );
      const r = result.rows[0];
      return {
        id: String(r.id),
        orderId: r.order_id,
        fillPrice: r.fill_price,
        fillSize: r.fill_size
      };
    }
  };

  positions = {
    insert: async (row: {
      opportunityId: string;
      kalshiOrderId: string | null;
      polyOrderId: string | null;
      status: string;
      pnl?: string;
    }): Promise<RecordedPosition> => {
      const result = await this.pool.query(
        `insert into positions (opportunity_id, kalshi_order_id, poly_order_id, status, pnl)
         values ($1, $2, $3, $4, $5)
         returning id, opportunity_id, kalshi_order_id, poly_order_id, status`,
        [row.opportunityId, row.kalshiOrderId, row.polyOrderId, row.status, row.pnl ?? "0"]
      );
      const r = result.rows[0];
      return {
        id: String(r.id),
        opportunityId: String(r.opportunity_id),
        kalshiOrderId: r.kalshi_order_id ? String(r.kalshi_order_id) : null,
        polyOrderId: r.poly_order_id ? String(r.poly_order_id) : null,
        status: r.status
      };
    }
  };
}