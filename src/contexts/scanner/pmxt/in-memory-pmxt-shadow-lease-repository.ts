import { randomUUID } from "crypto";
import {
  ClaimLeaseOptions,
  PmxtShadowLeaseRepository,
  ShadowLeaseClaim
} from "./pmxt-shadow-lease-repository";

export interface AuthoritativeScanSummary {
  scanRunId: string;
  completedAt: string;
}

export class InMemoryPmxtShadowLeaseRepository implements PmxtShadowLeaseRepository {
  private attempts: Map<string, Array<Omit<ShadowLeaseClaim, "authoritativeScanRunId">>> = new Map();

  constructor(private readonly eligibleScans: readonly AuthoritativeScanSummary[]) {}

  async claimOldestEligibleScan(options: ClaimLeaseOptions): Promise<ShadowLeaseClaim | undefined> {
    const sorted = [...this.eligibleScans].sort(
      (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
    );

    for (const scan of sorted) {
      const history = this.attempts.get(scan.scanRunId) ?? [];
      const active = history.find((a) => a.leasedUntil > options.now);
      if (active) continue;

      const attemptNumber = history.length + 1;
      const shadowRunId = options.nextShadowRunId ? options.nextShadowRunId() : randomUUID();
      const leasedUntil = new Date(
        new Date(options.now).getTime() + options.leaseDurationMs
      ).toISOString();

      const claim: ShadowLeaseClaim = {
        authoritativeScanRunId: scan.scanRunId,
        shadowRunId,
        attemptNumber,
        claimedAt: options.now,
        leasedUntil
      };

      this.attempts.set(scan.scanRunId, [
        ...history,
        {
          shadowRunId: claim.shadowRunId,
          attemptNumber: claim.attemptNumber,
          claimedAt: claim.claimedAt,
          leasedUntil: claim.leasedUntil
        }
      ]);

      return claim;
    }

    return undefined;
  }
}
