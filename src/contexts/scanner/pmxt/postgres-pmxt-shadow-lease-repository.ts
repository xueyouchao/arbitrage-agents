import { Pool, QueryResultRow } from "pg";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  ClaimLeaseOptions,
  PmxtShadowLeaseRepository,
  ShadowLeaseClaim
} from "./pmxt-shadow-lease-repository";
import { DATABASE_POOL } from "../../shared/database/database-tokens";

interface ClaimResult {
  authoritative_scan_run_id: string;
  shadow_run_id: string;
  attempt_number: number;
  claimed_at: Date;
  leased_until: Date;
}

// Issue #93: Postgres adapter for the PMXT shadow logical-run lease.
//
// `claimOldestEligibleScan` selects the oldest completed authoritative scan
// that has no currently active lease (leased_until > now) and inserts the
// next attempt number. The insert is guarded by a unique index on
// (authoritative_scan_run_id, attempt_number); a concurrent worker will
// either win the scan or be blocked on a different eligible scan. If the
// chosen scan is concurrently claimed, the transaction rolls back and the
// caller can retry.
@Injectable()
export class PostgresPmxtShadowLeaseRepository implements PmxtShadowLeaseRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async claimOldestEligibleScan(options: ClaimLeaseOptions): Promise<ShadowLeaseClaim | undefined> {
    const leasedUntil = new Date(
      new Date(options.now).getTime() + options.leaseDurationMs
    ).toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ClaimResult>(
        `with eligible as (
           select sr.id
           from scan_runs sr
           where sr.status = 'succeeded'
             and not exists (
               select 1
               from pmxt_shadow_run_attempts att
               where att.authoritative_scan_run_id = sr.id
                 and att.leased_until > $1::timestamptz
             )
           order by sr.completed_at asc
           limit 1
           for update skip locked
         ),
         next_attempt as (
           select
             e.id as authoritative_scan_run_id,
             coalesce(max(att.attempt_number), 0) + 1 as attempt_number
           from eligible e
           left join pmxt_shadow_run_attempts att
             on att.authoritative_scan_run_id = e.id
           group by e.id
         )
         insert into pmxt_shadow_run_attempts (
           shadow_run_id, authoritative_scan_run_id, attempt_number,
           claimed_at, leased_until, worker_id, status
         )
         select $2::uuid, na.authoritative_scan_run_id, na.attempt_number,
                $3::timestamptz, $4::timestamptz, $5, 'claimed'
         from next_attempt na
         returning authoritative_scan_run_id, shadow_run_id, attempt_number, claimed_at, leased_until`,
        [options.now, options.nextShadowRunId ? options.nextShadowRunId() : randomUUID(), options.now, leasedUntil, options.workerId]
      );

      await client.query("commit");

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      return {
        authoritativeScanRunId: row.authoritative_scan_run_id,
        shadowRunId: row.shadow_run_id,
        attemptNumber: row.attempt_number,
        claimedAt: row.claimed_at.toISOString(),
        leasedUntil: row.leased_until.toISOString()
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAttempts(authoritativeScanRunId: string): Promise<readonly ShadowLeaseClaim[]> {
    const result = await this.pool.query<ClaimResult & QueryResultRow>(
      `select authoritative_scan_run_id, shadow_run_id, attempt_number, claimed_at, leased_until
       from pmxt_shadow_run_attempts
       where authoritative_scan_run_id = $1
       order by attempt_number asc`,
      [authoritativeScanRunId]
    );
    return result.rows.map((row) => ({
      authoritativeScanRunId: row.authoritative_scan_run_id,
      shadowRunId: row.shadow_run_id,
      attemptNumber: row.attempt_number,
      claimedAt: row.claimed_at.toISOString(),
      leasedUntil: row.leased_until.toISOString()
    }));
  }
}
