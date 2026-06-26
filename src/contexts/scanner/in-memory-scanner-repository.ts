import { randomUUID } from "crypto";
import { PaperTradeSimulation } from "../arbitrage/domain/paper-trade-simulator";
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
  // All per-scan artifact collections are keyed by scanRun.id so that a
  // resumed run (which re-invokes saveCompletedScan with the same id)
  // replaces the prior set instead of appending duplicates. This mirrors
  // the Postgres idempotency contract: `delete ... where scan_run_id = $1`
  // (for snapshots) and upserts / `on conflict do update` for the rest,
  // all within the same transaction.
  private readonly scanRunsById = new Map<string, ScanResult>();
  private readonly normalizedMarketsByScanRunId = new Map<string, NormalizedMarket[]>();
  private readonly candidatePairsByScanRunId = new Map<string, ReviewedCandidatePair[]>();
  private readonly orderbookSnapshotsByScanRunId = new Map<string, OrderbookSnapshotArtifact[]>();
  private readonly opportunitiesByScanRunId = new Map<string, OpportunityWithSourceSnapshots[]>();
  private readonly paperTradeSimulationsByScanRunId = new Map<string, PaperTradeSimulation[]>();
  private readonly snapshotsByScanRunId = new Map<string, VenueMarketSnapshot[]>();

  /** Collected by saveCompletedScan; exposed for test assertions and
   * operator diagnostics on the in-memory adapter. Each getter flattens
   * the per-scan-run Map values so callers see a single flat array. */
  get scanRuns(): ScanResult[] {
    return [...this.scanRunsById.values()];
  }
  get normalizedMarkets(): NormalizedMarket[] {
    return [...this.normalizedMarketsByScanRunId.values()].flat();
  }
  get candidatePairs(): ReviewedCandidatePair[] {
    return [...this.candidatePairsByScanRunId.values()].flat();
  }
  get orderbookSnapshots(): OrderbookSnapshotArtifact[] {
    return [...this.orderbookSnapshotsByScanRunId.values()].flat();
  }
  get opportunities(): OpportunityWithSourceSnapshots[] {
    return [...this.opportunitiesByScanRunId.values()].flat();
  }
  get paperTradeSimulations(): PaperTradeSimulation[] {
    return [...this.paperTradeSimulationsByScanRunId.values()].flat();
  }
  get snapshots(): VenueMarketSnapshot[] {
    return [...this.snapshotsByScanRunId.values()].flat();
  }

  saveScanRun(scanRun: ScanResult): Promise<void> {
    this.scanRunsById.set(scanRun.id, scanRun);
    return Promise.resolve();
  }

  saveCompletedScan(artifacts: CompletedScanArtifacts): Promise<CompletedScanResult> {
    const completedScanRun = artifacts.completeScanRun(artifacts.scanRun);
    const scanRunId = artifacts.scanRun.id;
    // Replace, not append: each collection is keyed by scanRunId so a
    // resumed run converges on a single artifact set rather than
    // appending duplicates.
    this.snapshotsByScanRunId.set(scanRunId, [...artifacts.snapshots]);
    this.normalizedMarketsByScanRunId.set(scanRunId, artifacts.normalizedMarkets.map((review) => review.market));
    this.candidatePairsByScanRunId.set(scanRunId, [...artifacts.candidatePairs]);
    this.orderbookSnapshotsByScanRunId.set(scanRunId, [...artifacts.orderbookSnapshots]);
    this.opportunitiesByScanRunId.set(scanRunId, [...artifacts.opportunities]);
    this.paperTradeSimulationsByScanRunId.set(scanRunId, [...artifacts.paperTradeSimulations]);
    this.scanRunsById.set(scanRunId, completedScanRun);
    return Promise.resolve(completedScanRun);
  }

  listScanRuns(): Promise<readonly ScanResult[]> {
    return Promise.resolve([...this.scanRunsById.values()]);
  }
}

// Phase 4: in-memory implementation of `ScanStepRepository`. Mirrors the
// Postgres append-only step trail so tests catch the same resumability
// bugs the database would catch in production. `rows` is the single source
// of truth; `byRunId` is derived on read for test/debug callers.
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
    const existingForStep = this.rows.filter(
      (r) => r.scanRunId === step.scanRunId && r.stepName === step.stepName
    );
    const nextAttempt = step.attempt ?? (existingForStep.length === 0 ? 1 : Math.max(...existingForStep.map((r) => r.attempt)) + 1);
    const row: ScanStepRow = {
      id: randomUUID(),
      scanRunId: step.scanRunId,
      stepName: step.stepName,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      attempt: nextAttempt,
      failureReason: step.failureReason,
      metadata: step.metadata ?? {}
    };
    this.rows.push(row);
    return row;
  }

  listForRun(scanRunId: string): Promise<readonly ScanStepRow[]> {
    const filtered = this.rows.filter((r) => r.scanRunId === scanRunId);
    const byAttempt = new Map<number, ScanStepRow[]>();
    for (const row of filtered) {
      const bucket = byAttempt.get(row.attempt) ?? [];
      bucket.push(row);
      byAttempt.set(row.attempt, bucket);
    }

    const ordered: ScanStepRow[] = [];
    for (const attempt of Array.from(byAttempt.keys()).sort((a, b) => a - b)) {
      ordered.push(...byAttempt.get(attempt)!);
    }
    return Promise.resolve(ordered);
  }

  getStep(scanRunId: string, stepName: ScanStepName): Promise<ScanStepRow | undefined> {
    const rows = this.rows.filter((r) => r.scanRunId === scanRunId && r.stepName === stepName);
    if (rows.length === 0) return Promise.resolve(undefined);
    return Promise.resolve(rows.reduce((latest, current) => (current.attempt > latest.attempt ? current : latest)));
  }

  async markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void> {
    this.heartbeats.set(scanRunId, heartbeatAt);
  }

  heartbeatOf(scanRunId: string): string | undefined {
    return this.heartbeats.get(scanRunId);
  }
}
