// Phase 4: Postgres adapter for the resumable scanner's step trail.
//
// `saveStep` is an upsert keyed by (scan_run_id, step_name) — the same
// unique index that gates the test path. Idempotency is enforced at the
// database level: a duplicate insert on a succeeded step is silently
// dropped (DO NOTHING) so a transient restart that double-saves the
// final state cannot leave a tombstone. The orchestrator relies on this
// to safely re-run a step whose success the previous worker believed
// but never managed to persist.
//
// `markRunHeartbeat` is a one-line UPDATE on `scan_runs.heartbeat_at`.
// Heartbeats are an opportunistic best-effort signal; the abandoned-scan
// detector tolerates brief clock skew between the worker and the
// detector by re-deriving the heartbeat from the latest `scan_steps`
// `completed_at` when `heartbeat_at` is missing.

import { Pool, PoolClient } from "pg";
import { ScanStepArtifact, ScanStepName, ScanStepRepository, ScanStepRow, ScanStepStatus } from "./scan-step";

export class PostgresScanStepRepository implements ScanStepRepository {
  constructor(private readonly pool: Pool) {}

  async saveStep(step: ScanStepArtifact): Promise<ScanStepRow> {
    return saveStepRow(this.pool, step);
  }

  async listForRun(scanRunId: string): Promise<ScanStepRow[]> {
    return loadRunSteps(this.pool, scanRunId);
  }

  async getStep(scanRunId: string, stepName: ScanStepName): Promise<ScanStepRow | undefined> {
    const steps = await this.listForRun(scanRunId);
    const matching = steps.filter((step) => step.stepName === stepName);
    return matching.length === 0 ? undefined : matching[matching.length - 1];
  }

  async markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void> {
    await markRunHeartbeat(this.pool, scanRunId, heartbeatAt);
  }
}

export interface LoadedRunState {
  scanRunId: string;
  steps: ScanStepRow[];
  heartbeatAt: string | undefined;
}

export async function loadRunState(pool: Pool, scanRunId: string): Promise<LoadedRunState> {
  const [steps, heartbeatResult] = await Promise.all([
    loadRunSteps(pool, scanRunId),
    pool.query<{ heartbeat_at: Date | null }>(`select heartbeat_at from scan_runs where id = $1`, [scanRunId])
  ]);
  return {
    scanRunId,
    steps,
    heartbeatAt: heartbeatResult.rows[0]?.heartbeat_at?.toISOString()
  };
}

async function loadRunSteps(queryable: Pool | PoolClient, scanRunId: string): Promise<ScanStepRow[]> {
  const stepsResult = await queryable.query<{
    id: string;
    step_name: ScanStepName;
    status: ScanStepStatus;
    started_at: Date;
    completed_at: Date | null;
    attempt: number;
    failure_reason: string | null;
    metadata: Record<string, unknown>;
  }>(
    `select id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata
     from scan_steps
     where scan_run_id = $1
     order by started_at asc, id asc`,
    [scanRunId]
  );
  return stepsResult.rows.map((r) => ({
    id: r.id,
    scanRunId,
    stepName: r.step_name,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : undefined,
    attempt: r.attempt,
    failureReason: r.failure_reason ?? undefined,
    metadata: r.metadata ?? {}
  }));
}

async function saveStepRow(queryable: Pool | PoolClient, step: ScanStepArtifact): Promise<ScanStepRow> {
  // Phase 4 keeps history: every saveStep call inserts a new row. The
  // orchestrator's latestByName map in ResumableScanner.runOnce picks
  // the most recent row per (scan_run_id, step_name), so duplicates
  // are tolerated and retries are visible in the trail.
  const result = await queryable.query<{
    id: string;
    step_name: ScanStepName;
    status: ScanStepStatus;
    started_at: Date;
    completed_at: Date | null;
    attempt: number;
    failure_reason: string | null;
    metadata: Record<string, unknown>;
  }>(
    `insert into scan_steps (
       scan_run_id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata`,
    [
      step.scanRunId,
      step.stepName,
      step.status,
      step.startedAt,
      step.completedAt ?? null,
      step.attempt ?? 1,
      step.failureReason ?? null,
      JSON.stringify(step.metadata ?? {})
    ]
  );
  const row = result.rows[0];
  return {
    id: row.id,
    scanRunId: step.scanRunId,
    stepName: row.step_name,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : undefined,
    attempt: row.attempt,
    failureReason: row.failure_reason ?? undefined,
    metadata: row.metadata ?? {}
  };
}

async function markRunHeartbeat(queryable: Pool | PoolClient, scanRunId: string, heartbeatAt: string): Promise<void> {
  await queryable.query(
    `update scan_runs
     set heartbeat_at = $2
     where id = $1`,
    [scanRunId, heartbeatAt]
  );
}
