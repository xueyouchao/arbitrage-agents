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
// Postgres upsert key (scan_run_id, step_name) so the in-memory tests
// catch the same idempotency bugs the database would catch in
// production. `byRunId` is a debugging-only map exposed for tests.
export class InMemoryScanStepRepository implements ScanStepRepository {
  readonly rows: ScanStepRow[] = [];
  readonly byRunId: Map<string, ScanStepRow[]> = new Map();
  private readonly heartbeats: Map<string, string> = new Map();

  async saveStep(step: ScanStepArtifact): Promise<ScanStepRow> {
    const existing = this.rows.find((r) => r.scanRunId === step.scanRunId && r.stepName === step.stepName);
    // Idempotency contract on (scan_run_id, step_name, status):
    //   - Re-saving the SAME succeeded row is a no-op.
    //   - Re-saving a succeeded row with NEW metadata (e.g. the
    //     `rehydrated: true` flag set by the orchestrator on resume)
    //     merges the metadata into the existing row so the trail
    //     records the skip-on-resume without losing the canonical
    //     succeeded row.
    //   - Saving a NEW status (failed → succeeded, succeeded → running,
    //     etc.) KEEPS THE PRIOR ROW IN HISTORY and appends a new row.
    //     This mirrors the worker operator's expectation that they can
    //     see every retry of a step in the trail. The orchestrator's
    //     listForRun consumers should always read the most recent row
    //     for a step name; the test that checks for `failed → succeeded`
    //     depends on this history.
    if (existing && existing.status === "succeeded" && step.status === "succeeded") {
      if (step.metadata) {
        const merged: ScanStepRow = { ...existing, metadata: { ...existing.metadata, ...step.metadata } };
        const index = this.rows.indexOf(existing);
        this.rows[index] = merged;
        this.refreshByRunId(step.scanRunId);
        return merged;
      }
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
    this.refreshByRunId(step.scanRunId);
    return row;
  }

  listForRun(scanRunId: string): Promise<ScanStepRow[]> {
    return Promise.resolve([...(this.byRunId.get(scanRunId) ?? [])]);
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

  private refreshByRunId(scanRunId: string): void {
    this.byRunId.set(scanRunId, this.rows.filter((r) => r.scanRunId === scanRunId));
  }
}
