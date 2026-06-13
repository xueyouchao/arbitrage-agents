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
// Postgres history semantics so unit tests catch the same retry-trail
// behavior the database would exhibit in production. Every `saveStep`
// appends a new row with `attempt = max(existing attempts) + 1`.
// `listForRun` returns rows ordered by `attempt`, then `started_at`,
// then `id`, matching the Postgres contract. `getStep` returns the
// latest row (highest attempt) for a step name.
export class InMemoryScanStepRepository implements ScanStepRepository {
  readonly rows: ScanStepRow[] = [];
  private readonly heartbeats: Map<string, string> = new Map();

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

  listForRun(scanRunId: string): Promise<ScanStepRow[]> {
    // Preserve insertion order within the same attempt so the trail
    // mirrors the Postgres behavior when rows are sorted by attempt and
    // then by insertion sequence (via monotonic id generation).
    const filtered = this.rows.filter((r) => r.scanRunId === scanRunId);
    const byAttempt = new Map<number, ScanStepRow[]>();
    for (const row of filtered) {
      const bucket = byAttempt.get(row.attempt) ?? [];
      bucket.push(row);
      byAttempt.set(row.attempt, bucket);
    }
    const attempts = Array.from(byAttempt.keys()).sort((a, b) => a - b);
    const ordered: ScanStepRow[] = [];
    for (const attempt of attempts) {
      ordered.push(...byAttempt.get(attempt)!);
    }
    return Promise.resolve(ordered);
  }

  getStep(scanRunId: string, stepName: ScanStepName): Promise<ScanStepRow | undefined> {
    return Promise.resolve(latestForStep(this.rows, scanRunId, stepName));
  }

  async markRunHeartbeat(scanRunId: string, heartbeatAt: string): Promise<void> {
    this.heartbeats.set(scanRunId, heartbeatAt);
  }

  heartbeatOf(scanRunId: string): string | undefined {
    return this.heartbeats.get(scanRunId);
  }
}

function latestForStep(rows: readonly ScanStepRow[], scanRunId: string, stepName: ScanStepName): ScanStepRow | undefined {
  const forStep = rows.filter((r) => r.scanRunId === scanRunId && r.stepName === stepName);
  if (forStep.length === 0) return undefined;
  return forStep.reduce((latest, current) =>
    current.attempt > latest.attempt ? current : latest
  );
}
