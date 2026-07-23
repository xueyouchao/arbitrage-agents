import { Pool, PoolClient, QueryResultRow } from "pg";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  ClaimLeaseOptions,
  FinalizeShadowAttemptOptions,
  PmxtShadowLeaseRepository,
  ShadowAttempt,
  ShadowAttemptStatus,
  ShadowLeaseClaim
} from "./pmxt-shadow-lease-repository";
import { DATABASE_POOL } from "../../shared/database/database-tokens";

interface ClaimResult {
  id: string;
  authoritative_scan_run_id: string;
  shadow_run_id: string;
  attempt_number: number;
  claimed_at: Date;
  leased_until: Date;
}

interface AttemptResult extends ClaimResult {
  worker_id: string;
  status: ShadowAttemptStatus;
  retry_reason: string | null;
  next_retry_at: Date | null;
  max_attempts: number;
}

// Issue #93: Postgres adapter for the PMXT shadow logical-run lease.
//
// `claimOldestEligibleScan` selects the oldest completed authoritative scan
// with neither a terminal attempt nor a currently active claimed lease, then
// inserts the next attempt number. Failed, partial, and expired claims remain
// retryable subject to deterministic backoff (next_retry_at) and max_attempts.
// Exhausted attempts are terminal and never reclaimed. The insert is guarded
// by a unique index on (authoritative_scan_run_id, attempt_number); a
// concurrent worker will either win the scan or be blocked on a different
// eligible scan. If the chosen scan is concurrently claimed, the transaction
// rolls back and the caller can retry.
@Injectable()
export class PostgresPmxtShadowLeaseRepository implements PmxtShadowLeaseRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async claimOldestEligibleScan(options: ClaimLeaseOptions): Promise<ShadowLeaseClaim | undefined> {
    const maxAttempts = options.maxAttempts ?? 5;
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
                 and (
                   att.status in ('completed', 'sample_excluded', 'exhausted')
                   or (att.status = 'claimed' and att.leased_until > $1::timestamptz)
                   or (att.status in ('failed', 'partial')
                       and att.next_retry_at is not null
                       and att.next_retry_at > $1::timestamptz)
                 )
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
           claimed_at, leased_until, worker_id, status, max_attempts
         )
         select $2::uuid, na.authoritative_scan_run_id, na.attempt_number,
                $3::timestamptz, $4::timestamptz, $5, 'claimed', $6
         from next_attempt na
         returning id, authoritative_scan_run_id, shadow_run_id, attempt_number, claimed_at, leased_until`,
        [options.now, options.nextShadowRunId ? options.nextShadowRunId() : randomUUID(), options.now, leasedUntil, options.workerId, maxAttempts]
      );

      await client.query("commit");

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      return {
        shadowRunAttemptId: row.id,
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

  async finalizeAttempt(options: FinalizeShadowAttemptOptions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // Read the attempt to compute backoff and verify lease is still active.
      const nowParam = options.now ?? new Date().toISOString();
      const attemptResult = await client.query<{ attempt_number: number; max_attempts: number; claimed_at: Date; leased_until: Date }>(
        `select attempt_number, max_attempts, claimed_at, leased_until
         from pmxt_shadow_run_attempts
         where id = $1::uuid and worker_id = $2 and status = 'claimed'
           and leased_until > $3::timestamptz
         for update`,
        [options.shadowRunAttemptId, options.workerId, nowParam]
      );

      if (attemptResult.rowCount !== 1) {
        await client.query("rollback");
        throw new Error(`worker ${options.workerId} does not own claimed shadow attempt`);
      }

      const { attempt_number, max_attempts, claimed_at } = attemptResult.rows[0];
      let finalStatus = options.status;
      let nextRetryAt: string | null = null;

      if (isRetryable(options.status)) {
        if (attempt_number >= max_attempts) {
          finalStatus = "exhausted";
        } else {
          nextRetryAt = computeNextRetryAt(attempt_number, claimed_at.toISOString());
        }
      }

      await client.query(
        `update pmxt_shadow_run_attempts
         set status = $3, retry_reason = $4, next_retry_at = $5::timestamptz
         where id = $1::uuid and worker_id = $2 and status = 'claimed'`,
        [options.shadowRunAttemptId, options.workerId, finalStatus, options.retryReason ?? null, nextRetryAt]
      );

      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAttempts(authoritativeScanRunId: string): Promise<readonly ShadowAttempt[]> {
    const result = await this.pool.query<AttemptResult & QueryResultRow>(
      `select id, authoritative_scan_run_id, shadow_run_id, attempt_number, claimed_at,
              leased_until, worker_id, status, retry_reason, next_retry_at, max_attempts
       from pmxt_shadow_run_attempts
       where authoritative_scan_run_id = $1
       order by attempt_number asc`,
      [authoritativeScanRunId]
    );
    return result.rows.map((row) => ({
      shadowRunAttemptId: row.id,
      authoritativeScanRunId: row.authoritative_scan_run_id,
      shadowRunId: row.shadow_run_id,
      attemptNumber: row.attempt_number,
      claimedAt: row.claimed_at.toISOString(),
      leasedUntil: row.leased_until.toISOString(),
      workerId: row.worker_id,
      status: row.status,
      retryReason: row.retry_reason ?? undefined,
      nextRetryAt: row.next_retry_at?.toISOString(),
      maxAttempts: row.max_attempts
    }));
  }
}

function isRetryable(status: ShadowAttemptStatus): boolean {
  return status === "partial" || status === "failed";
}

/**
 * Deterministic exponential backoff: 2^attempt * 60s, capped at 1 hour.
 */
function computeNextRetryAt(attemptNumber: number, claimedAt: string): string {
  const backoffMs = Math.min(Math.pow(2, attemptNumber) * 60_000, 3_600_000);
  return new Date(new Date(claimedAt).getTime() + backoffMs).toISOString();
}
