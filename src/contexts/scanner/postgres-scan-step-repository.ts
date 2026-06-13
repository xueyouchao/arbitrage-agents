// Phase 4: Postgres adapter for the resumable scanner's step trail.
//
// `saveStep` appends a new history row on every call. Each row gets an
// attempt number one greater than the current maximum for the same
// `(scan_run_id, step_name)`. A unique index on those three columns guards
// against duplicate attempts from concurrent workers; the insert loop
// retries on a unique violation so transient races converge safely.
//
// `listForRun` and `getStep` query the table directly via the shared pool.
// They are async to match the in-memory adapter and the `ScanStepRepository`
// interface; callers always `await` the result.
//
// `markRunHeartbeat` is a one-line UPDATE on `scan_runs.heartbeat_at`.
// Heartbeats are an opportunistic best-effort signal; the abandoned-scan
// detector tolerates brief clock skew between the worker and the detector by
// re-deriving the heartbeat from the latest `scan_steps` `completed_at` when
// `heartbeat_at` is missing.

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
    const matching = steps.filter((step) => step.stepName === stepName);
    return matching.length === 0 ? undefined : matching[matching.length - 1];
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
     order by attempt asc, started_at asc, id asc`,
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

const MAX_ATTEMPT_RETRIES = 3;

async function saveStepRow(queryable: Pool | PoolClient, step: ScanStepArtifact): Promise<ScanStepRow> {
  const suppliedAttempt = step.attempt;
  let lastError: unknown;

  for (let retry = 0; retry < MAX_ATTEMPT_RETRIES; retry += 1) {
    try {
      const result = await queryable.query<StepRow>(
        `insert into scan_steps (
           scan_run_id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata
         ) values (
           $1,
           $2,
           $3,
           $4,
           $5,
           coalesce(
             $6,
             (select coalesce(max(attempt), 0) + 1 from scan_steps where scan_run_id = $1 and step_name = $2)
           ),
           $7,
           $8::jsonb
         )
         returning id, step_name, status, started_at, completed_at, attempt, failure_reason, metadata`,
        [
          step.scanRunId,
          step.stepName,
          step.status,
          step.startedAt,
          step.completedAt ?? null,
          suppliedAttempt ?? null,
          step.failureReason ?? null,
          JSON.stringify(step.metadata ?? {})
        ]
      );
      return mapStepRow(step.scanRunId, result.rows[0]);
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) throw error;
      // A concurrent worker inserted the same attempt; retry so the
      // max(attempt) subquery recomputes. If the caller supplied an
      // explicit attempt number there is nothing to recompute, so fail
      // fast instead of looping on a deterministic collision.
      if (suppliedAttempt !== undefined) throw error;
    }
  }

  throw new Error(
    `Failed to persist scan step ${step.stepName} for run ${step.scanRunId} after ${MAX_ATTEMPT_RETRIES} attempts due to concurrent attempt collisions`,
    { cause: lastError }
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}

async function markRunHeartbeat(queryable: Pool | PoolClient, scanRunId: string, heartbeatAt: string): Promise<void> {
  await queryable.query(
    `update scan_runs
     set heartbeat_at = $2
     where id = $1`,
    [scanRunId, heartbeatAt]
  );
}
