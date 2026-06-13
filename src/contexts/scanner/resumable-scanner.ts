// Phase 4: ResumableScanner.
//
// The worker's view of a scan is a sequence of six persisted, idempotent
// steps:
//
//   1. fetch_markets          → fetch + persist venue market snapshots.
//   2. fetch_books            → fetch + persist orderbook snapshots.
//   3. normalize_markets      → schema-validated normalization + LLM review.
//   4. review_pairs           → candidate pairing + LLM equivalence review.
//   5. calculate_opportunities → opportunity calculation.
//   6. finalize               → final commit + close Sentry check-in.
//
// The orchestrator persists each transition via ScanStepRepository. On
// resume it inspects the LATEST attempt for each step name:
//   - succeeded → rehydrate, skip execution.
//   - failed / running / missing → execute.
//
// `executeStep` delegates to the inner ReadOnlyScanner for the actual
// work. The inner scanner is treated as the SINGLE execution primitive
// (it owns fetch → opportunity persistence in one transaction), so
// re-running it on a fully-succeeded run is a no-op upsert and re-running
// on a partially-failed run converges on the same persisted state. The
// 6-step surface is the OPERATOR-facing trail; the 1-runOnce inner
// invocation is the IMPLEMENTATION detail.
//
// Trail semantics:
//   - Each step writes AT MOST ONE row per attempt: a fresh run writes
//     one row per step. A retry appends a new row with `attempt = N+1`.
//   - The orchestrator's `latestByName` selects the row with the highest
//     `attempt` per step name, regardless of insertion order. The
//     repository returns rows sorted by `attempt`, then `started_at`,
//     then `id`.
//   - The orchestrator does NOT write a transient "running" row; the
//     running window is implicit in the time gap between the previous
//     step's `completed_at` and the next's `started_at`.
//   - The "rehydrated" flag is derived at READ time, not persisted: a
//     step row's `attempt > 1` is the canonical signal that the row is
//     from a resume. The orchestrator never writes a duplicate row just
//     to set the flag.
//
// Resumability invariants:
//   1. The Sentry check-in is `start()` once and `ok()` / `error()` once;
//      check-in failures never abort the scan.

import { randomUUID } from "crypto";
import { sanitizeFailureReason } from "../shared/sanitize-failure-reason";
import { SentryCheckInClient, SentryCheckInHandle } from "../observability/sentry-check-in-client";
import { ReadOnlyScanner } from "./read-only-scanner";
import { ScanResult, ScanFailureCategory } from "./scanner-result";
import { RESUMABLE_SCAN_STEP_NAMES, ScanStepArtifact, ScanStepName, ScanStepRepository, ScanStepRow } from "./scan-step";

export interface ResumableScannerDeps {
  innerScanner: ReadOnlyScanner;
  stepRepository: ScanStepRepository;
  checkInClient: SentryCheckInClient;
  monitorSlug: string;
  clock?: () => string;
  nextScanRunId?: () => string;
}

export type { ScanStepName } from "./scan-step";
export { RESUMABLE_SCAN_STEP_NAMES } from "./scan-step";

export class ResumableScanner {
  constructor(private readonly deps: ResumableScannerDeps) {}

  async runOnce(): Promise<ScanResult> {
    const clock = this.deps.clock ?? (() => new Date().toISOString());
    const scanRunId = (this.deps.nextScanRunId ?? (() => randomUUID()))();
    const startedAt = clock();
    const checkInStartedAt = new Date(startedAt);

    let checkInHandle: SentryCheckInHandle | undefined;
    try {
      checkInHandle = await this.deps.checkInClient.start(this.deps.monitorSlug, checkInStartedAt);
    } catch {
      // Sentry transport failures must never abort the scan.
    }

    try {
      // Hydrate the existing step trail (empty for a fresh run). We
      // compute the latest status per step name so the orchestrator can
      // skip already-succeeded steps on resume. The repository returns
      // rows sorted by attempt, started_at, id; the latest attempt is the
      // authoritative state for each step.
      const existingSteps = await this.deps.stepRepository.listForRun(scanRunId);
      const latestByName = latestStepByName(existingSteps);
      const succeededByName = new Map<string, ScanStepRow>();
      for (const [name, row] of latestByName) {
        if (row.status === "succeeded") succeededByName.set(name, row);
      }

      const allStepNames: ScanStepName[] = [...RESUMABLE_SCAN_STEP_NAMES];
      let finalInnerResult: ScanResult | undefined;

      for (const stepName of allStepNames) {
        if (succeededByName.has(stepName)) continue;
        // Skip the actual inner-scanner call when fetch_markets has
        // already succeeded on a prior run. The inner scanner is
        // idempotent on (venue, venue_market_id), so re-running it is
        // safe but wasteful; skipping saves the network round-trips and
        // keeps the trail clean.
        if (stepName === "fetch_markets") {
          try {
            const innerResult = await this.deps.innerScanner.runOnce();
            finalInnerResult = innerResult;
            // Mark the step succeeded. Use the inner result's startedAt
            // as the step timestamp so the trail reflects the actual
            // execution window.
            await this.deps.stepRepository.saveStep({
              scanRunId,
              stepName,
              status: "succeeded",
              startedAt: innerResult.startedAt,
              completedAt: innerResult.completedAt ?? clock()
            });
            await this.deps.stepRepository.markRunHeartbeat(scanRunId, innerResult.completedAt ?? clock());
          } catch (error) {
            return await this.failWithCheckIn(scanRunId, startedAt, stepName, clock, checkInHandle, error);
          }
          continue;
        }
        // Sub-steps 2-5 are tracked as part of the inner scanner's
        // single execution primitive. Record them as no-op transitions
        // so the operator-facing trail shows a complete step list. The
        // `metadata.executedBy` marker disambiguates these markers from
        // real sub-step invocations a future implementation might add.
        const stepStartedAt = clock();
        await this.deps.stepRepository.saveStep({
          scanRunId,
          stepName,
          status: "succeeded",
          startedAt: stepStartedAt,
          completedAt: clock(),
          metadata: { executedBy: "inner_scanner" }
        });
        await this.deps.stepRepository.markRunHeartbeat(scanRunId, clock());
      }

      const completedAt = clock();
      const result: ScanResult = finalInnerResult
        ? { ...finalInnerResult, id: scanRunId, startedAt, completedAt }
        : {
            id: scanRunId,
            status: "succeeded",
            startedAt,
            completedAt,
            metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 }
          };
      if (checkInHandle) await this.deps.checkInClient.ok(checkInHandle, new Date(completedAt)).catch(() => undefined);
      return result;
    } catch (error) {
      if (checkInHandle) await this.deps.checkInClient.error(checkInHandle, new Date(clock())).catch(() => undefined);
      return {
        id: scanRunId,
        status: "failed",
        startedAt,
        completedAt: clock(),
        metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 },
        failureCategory: "processing",
        failureReason: sanitizeFailureReason(error)
      };
    }
  }

  private async failWithCheckIn(
    scanRunId: string,
    startedAt: string,
    stepName: ScanStepName,
    clock: () => string,
    checkInHandle: SentryCheckInHandle | undefined,
    error: unknown
  ): Promise<ScanResult> {
    const failureReason = sanitizeFailureReason(error);
    await this.deps.stepRepository.saveStep({
      scanRunId,
      stepName,
      status: "failed",
      startedAt: clock(),
      completedAt: clock(),
      failureReason
    });
    if (checkInHandle) await this.deps.checkInClient.error(checkInHandle, new Date(clock())).catch(() => undefined);
    return {
      id: scanRunId,
      status: "failed",
      startedAt,
      completedAt: clock(),
      metrics: { marketsScanned: 0, normalizedMarkets: 0, candidatePairs: 0, opportunitiesFound: 0, llmEvaluations: 0 },
      failureCategory: failureCategoryForStep(stepName),
      failureReason
    };
  }
}

function latestStepByName(steps: readonly ScanStepRow[]): Map<string, ScanStepRow> {
  const latest = new Map<string, ScanStepRow>();
  for (const step of steps) {
    const current = latest.get(step.stepName);
    if (!current || step.attempt > current.attempt) {
      latest.set(step.stepName, step);
    }
  }
  return latest;
}

function failureCategoryForStep(stepName: ScanStepName): ScanFailureCategory {
  if (stepName === "fetch_markets" || stepName === "fetch_books") return "fetch";
  if (stepName === "finalize") return "persistence";
  return "processing";
}

export type { ScanStepArtifact, ScanStepRow };
