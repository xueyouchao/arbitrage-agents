// Phase 4: Postgres adapter for the resumable scanner's step trail.
//
// `saveStep` writes a new row per call. The orchestrator's
// `latestByName` map picks the most recent row per (scan_run_id,
// step_name), so a retried step appends a new row with `attempt = N+1`
// rather than overwriting the prior status. The full history is
// preserved for operator visibility (the
// `scan_steps_run_name_started_at_idx` composite index supports the
// `MAX(started_at)` lookup).
//
// `listForRun` and `getStep` query the table directly via the shared
// pool. They are async to match the in-memory adapter and the
// `ScanStepRepository` interface; callers always `await` the result.
//
// `markRunHeartbeat` is a one-line UPDATE on `scan_runs.heartbeat_at`.
// Heartbeats are an opportunistic best-effort signal; the abandoned-scan
// detector tolerates brief clock skew between the worker and the
// detector by re-deriving the heartbeat from the latest `scan_steps`
// `completed_at` when `heartbeat_at` is missing.

import { Pool, PoolClient } from "pg";
import { ScanStepArtifact, ScanStepName, ScanStepRepository, ScanStepRow, ScanStepStatus } from "./scan-step";

interface StepRow {
  id: string;
  step_name: ScanStepName;
  status: ScanStepStatus;
  started_at: Date;
  completed_at: Date | null;
  attempt: number;
  failure_reason: string | null;
  metadata: Record<string, unknown>;
}

export class PostgresScanStepRepository implements ScanStepRepository {
  constructor(private readonly pool: Pool) {}

  async saveStep(step: ScanStepArtifact): Promise<ScanStepRow> {
    return saveStepRow(this.pool, step);
  }

  async listForRun(scanRunId: string): Promise<readonly ScanStepRow[]> {
    return listStepsForRun(this.pool, scanRunId);
  }

  async getStep(scanRunId: string, stepName: ScanStepName): Promise<ScanStepRow | undefined> {
    const steps = await listStepsForRun(this.pool, scanRunId);
    // listStepsForRun orders by started_at ASC; the most recent row is
    // the last element of the array. We walk back-to-front so we find
    // the latest row for the requested step name on the first hit.
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].stepName === stepName) return steps[i];
    }
    return undefined;
  }

  async markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void> {
    await markRunHeartbeat(this.pool, scanRunId, heartbeatAt);
  }
}

export async function listStepsForRun(
  queryable: Pool | PoolClient,
  scanRunId: string
): Promise<readonly ScanStepRow[]> {
  const result = await queryable.query<StepRow>(
    `select id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata
     from scan_steps
     where scan_run_id = $1
     order by started_at asc`,
    [scanRunId]
  );
  return result.rows.map((r) => mapStepRow(scanRunId, r));
}

function mapStepRow(scanRunId: string, r: StepRow): ScanStepRow {
  return {
    id: r.id,
    scanRunId,
    stepName: r.step_name,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : undefined,
    attempt: r.attempt,
    failureReason: r.failure_reason ?? undefined,
    metadata: r.metadata ?? {}
  };
}

async function saveStepRow(queryable: Pool | PoolClient, step: ScanStepArtifact): Promise<ScanStepRow> {
  const result = await queryable.query<StepRow>(
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
  return mapStepRow(step.scanRunId, row);
}

async function markRunHeartbeat(queryable: Pool | PoolClient, scanRunId: string, heartbeatAt: string): Promise<void> {
  await queryable.query(
    `update scan_runs
     set heartbeat_at = $2
     where id = $1`,
    [scanRunId, heartbeatAt]
  );
}
