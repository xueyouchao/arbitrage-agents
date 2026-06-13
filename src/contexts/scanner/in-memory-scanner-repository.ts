import { randomUUID } from "crypto";
import { NormalizedMarket } from "../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../venues/domain/venue-market";
import {
  CompletedScanArtifacts,
  CompletedScanResult,
  OpportunityWithSourceSnapshots,
  OrderbookSnapshotArtifact,
  ReviewedCandidatePair,
  ScannerRepository
} from "./scanner-repository";
import { ScanResult } from "./scanner-result";
import { ScanStepArtifact, ScanStepName, ScanStepRepository, ScanStepRow } from "./scan-step";

export class InMemoryScannerRepository implements ScannerRepository {
  readonly scanRuns: ScanResult[] = [];
  readonly snapshots: VenueMarketSnapshot[] = [];
  readonly normalizedMarkets: NormalizedMarket[] = [];
  readonly candidatePairs: ReviewedCandidatePair[] = [];
  readonly orderbookSnapshots: OrderbookSnapshotArtifact[] = [];
  readonly opportunities: OpportunityWithSourceSnapshots[] = [];

  saveScanRun(scanRun: ScanResult): Promise<void> {
    const index = this.scanRuns.findIndex((existing) => existing.id === scanRun.id);
    if (index === -1) {
      this.scanRuns.push(scanRun);
    } else {
      this.scanRuns[index] = scanRun;
    }
    return Promise.resolve();
  }

  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<CompletedScanResult> {
    const completedScanRun = artifacts.completeScanRun(artifacts.scanRun);
    this.snapshots.push(...artifacts.snapshots);
    this.normalizedMarkets.push(...artifacts.normalizedMarkets.map((review) => review.market));
    this.candidatePairs.push(...artifacts.candidatePairs);
    this.orderbookSnapshots.push(...artifacts.orderbookSnapshots);
    this.opportunities.push(...artifacts.opportunities);
    this.scanRuns.push(completedScanRun);
    return Promise.resolve(completedScanRun);
  }

  listScanRuns(): Promise<readonly ScanResult[]> {
    return Promise.resolve([...this.scanRuns]);
  }
}

// Phase 4: in-memory implementation of `ScanStepRepository`. Mirrors the
// Postgres append-only step trail so tests catch the same resumability
// bugs the database would catch in production. `rows` is the single
// source of truth; `byRunId` is derived on read for test/debug callers.
export class InMemoryScanStepRepository implements ScanStepRepository {
  readonly rows: ScanStepRow[] = [];
  private readonly heartbeats: Map<string, string> = new Map();

  get byRunId(): Map<string, ScanStepRow[]> {
    const byRunId = new Map<string, ScanStepRow[]>();
    for (const row of this.rows) {
      const runRows = byRunId.get(row.scanRunId) ?? [];
      runRows.push(row);
      byRunId.set(row.scanRunId, runRows);
    }
    return byRunId;
  }

  async saveStep(step: ScanStepArtifact): Promise<ScanStepRow> {
    const existing = this.rows.find((r) => r.scanRunId === step.scanRunId && r.stepName === step.stepName);
    // Idempotency contract on (scan_run_id, step_name, status):
    //   - Re-saving the SAME succeeded row is a no-op.
    //   - Saving a NEW status (failed → succeeded, succeeded → running,
    //     etc.) KEEPS THE PRIOR ROW IN HISTORY and appends a new row.
    //     This mirrors the worker operator's expectation that they can
    //     see every retry of a step in the trail. The orchestrator's
    //     listForRun consumers should always read the most recent row
    //     for a step name; the test that checks for `failed → succeeded`
    //     depends on this history.
    if (existing && existing.status === "succeeded" && step.status === "succeeded") {
      return existing;
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    const row: ScanStepRow = {
      id: randomUUID(),
      scanRunId: step.scanRunId,
      stepName: step.stepName,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      attempt: step.attempt ?? attempt,
      failureReason: step.failureReason,
      metadata: step.metadata ?? {}
    };
    this.rows.push(row);
    return row;
  }

  listForRun(scanRunId: string): Promise<readonly ScanStepRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.scanRunId === scanRunId));
  }

  // Returns the most recent row for the (scanRunId, stepName) pair.
  // Used by the orchestrator's succeededByName map; the test suite
  // asserts on full history via listForRun.
  latestForRun(scanRunId: string, stepName: ScanStepName): ScanStepRow | undefined {
    const rows = this.rows.filter((r) => r.scanRunId === scanRunId && r.stepName === stepName);
    return rows.length === 0 ? undefined : rows[rows.length - 1];
  }

  getStep(scanRunId: string, stepName: ScanStepName): Promise<ScanStepRow | undefined> {
    return Promise.resolve(this.latestForRun(scanRunId, stepName));
  }

  async markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void> {
    this.heartbeats.set(scanRunId, heartbeatAt);
  }

  heartbeatOf(scanRunId: string): string | undefined {
    return this.heartbeats.get(scanRunId);
  }
}
