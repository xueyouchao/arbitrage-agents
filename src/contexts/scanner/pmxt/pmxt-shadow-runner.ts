import { createHash } from "crypto";
import { AppConfig, pmxtShadowConfigForFingerprint } from "../../../config/app-config";
import { PmxtShadowLeaseRepository } from "./pmxt-shadow-lease-repository";
import { PmxtShadowRateLimiter } from "./pmxt-shadow-rate-limiter";

export interface PmxtShadowRunResult {
  status: "disabled" | "skipped" | "claimed";
  shadowRunId?: string;
  authoritativeScanRunId?: string;
  attemptNumber?: number;
  reason?: string;
  startedAt: string;
  completedAt: string;
}

export interface PmxtShadowRunnerDeps {
  config: AppConfig;
  leaseRepository: PmxtShadowLeaseRepository;
  rateLimiter: PmxtShadowRateLimiter;
  workerId: string;
  leaseDurationMs?: number;
  nextShadowRunId?(): string;
  clock?: () => string;
}

export const PMXT_SHADOW_RUNNER = Symbol("PMXT_SHADOW_RUNNER");

// Issue #93: isolated shadow runner for the PMXT Hosted evaluation.
//
// The runner never touches production scanner tables beyond a read-only
// claim on the oldest succeeded authoritative scan run. All persistence
// is directed through the dedicated shadow lease repository, which writes
// only to `pmxt_shadow_run_attempts`. When shadowing is disabled, the
// runner exits cleanly with no external calls.
export class PmxtShadowRunner {
  constructor(private readonly deps: PmxtShadowRunnerDeps) {}

  async runOnce(): Promise<PmxtShadowRunResult> {
    const clock = this.deps.clock ?? (() => new Date().toISOString());
    const startedAt = clock();

    if (!this.deps.config.pmxtShadowEnabled) {
      return {
        status: "disabled",
        startedAt,
        completedAt: clock(),
        reason: "PMXT_SHADOW_ENABLED is false"
      };
    }

    const admission = this.deps.rateLimiter.allowRequest(0);
    if (!admission.allowed) {
      return {
        status: "skipped",
        startedAt,
        completedAt: clock(),
        reason: admission.reason
      };
    }

    const leaseDurationMs = this.deps.leaseDurationMs ?? 5 * 60 * 1000;
    const claim = await this.deps.leaseRepository.claimOldestEligibleScan({
      workerId: this.deps.workerId,
      leaseDurationMs,
      now: startedAt,
      nextShadowRunId: this.deps.nextShadowRunId
    });

    this.deps.rateLimiter.release();


    if (!claim) {
      return {
        status: "skipped",
        startedAt,
        completedAt: clock(),
        reason: "no eligible unclaimed authoritative scan"
      };
    }

    if (!isScanIncludedInSample(claim.authoritativeScanRunId, this.deps.config)) {
      return {
        status: "skipped",
        shadowRunId: claim.shadowRunId,
        authoritativeScanRunId: claim.authoritativeScanRunId,
        attemptNumber: claim.attemptNumber,
        startedAt,
        completedAt: clock(),
        reason: "sample_rate_excluded"
      };
    }

    return {
      status: "claimed",
      shadowRunId: claim.shadowRunId,
      authoritativeScanRunId: claim.authoritativeScanRunId,
      attemptNumber: claim.attemptNumber,
      startedAt,
      completedAt: clock()
    };
  }
}

export function isScanIncludedInSample(authoritativeScanRunId: string, config: AppConfig): boolean {
  const { numerator, denominator } = config.pmxtShadowSampleRate;
  if (numerator <= 0) return false;
  if (numerator >= denominator) return true;

  const cohortFingerprint = JSON.stringify(pmxtShadowConfigForFingerprint(config));
  const hashInput = `${authoritativeScanRunId}|${cohortFingerprint}|${numerator}/${denominator}`;
  const hash = createHash("sha256").update(hashInput).digest("hex");
  const value = BigInt(`0x${hash.slice(0, 16)}`);
  const mod = value % BigInt(denominator);
  return mod < BigInt(numerator);
}
