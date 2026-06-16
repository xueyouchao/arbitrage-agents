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
  readonly scanRuns: ScanResult[] = [];
  readonly snapshots: VenueMarketSnapshot[] = [];
  readonly normalizedMarkets: NormalizedMarket[] = [];
  readonly candidatePairs: ReviewedCandidatePair[] = [];
  readonly orderbookSnapshots: OrderbookSnapshotArtifact[] = [];
  readonly opportunities: OpportunityWithSourceSnapshots[] = [];
  // Phase 3 #6: collected by saveCompletedScan; exposed for test assertions
  // and operator diagnostics on the in-memory adapter.
  readonly paperTradeSimulations: PaperTradeSimulation[] = [];

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
    this.paperTradeSimulations.push(...artifacts.paperTradeSimulations);
    this.scanRuns.push(completedScanRun);
    return Promise.resolve(completedScanRun);
  }

  listScanRuns(): Promise<readonly ScanResult[]> {
    return Promise.resolve([...this.scanRuns]);
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
