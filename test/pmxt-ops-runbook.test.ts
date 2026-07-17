import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #100: Operator runbook validation.
//
// These tests verify that docs/PMXT-OPS-RUNBOOK.md satisfies every
// acceptance criterion from the GitHub issue. The runbook is a
// documentation artifact, but its structural completeness is
// testable: each criterion maps to a concrete section or keyword
// that must appear in the rendered document.

const RUNBOOK_PATH = join(__dirname, "..", "docs", "PMXT-OPS-RUNBOOK.md");

function readRunbook(): string {
  return readFileSync(RUNBOOK_PATH, "utf-8");
}

describe("PMXT ops runbook — acceptance criteria (issue #100)", () => {
  let runbook: string;

  it("exists as a markdown document", () => {
    runbook = readRunbook();
    expect(runbook.length).toBeGreaterThan(0);
    expect(runbook).toContain("# ");
  });

  // AC 1: The enablement checklist requires the authorization issue,
  // validated hosted config, migrations, low deterministic sample rate,
  // and monitoring before startup.
  describe("AC1 — Enablement checklist", () => {
    it("requires authorization issue acceptance before startup", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/authorization.*(issue|accept)/);
    });

    it("requires validated hosted config before startup", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/validat.*hosted.*config/);
    });

    it("requires migrations before startup", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("migration");
    });

    it("requires low deterministic sample rate before startup", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/(low|small).*deterministic.*sample/);
    });

    it("requires monitoring before startup", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("monitoring");
    });
  });

  // AC 2: Rollback stops/scales the shadow worker, disables flags,
  // restarts/redeploys startup-bound config, verifies zero PMXT requests,
  // and optionally revokes the key.
  describe("AC2 — Rollback procedure", () => {
    it("documents stopping or scaling the shadow worker", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/(stop|scale).*shadow.*worker/);
    });

    it("documents disabling PMXT flags", () => {
      runbook = readRunbook();
      expect(runbook).toContain("PMXT_SHADOW_ENABLED=false");
      expect(runbook).toContain("PMXT_SHADOW_READS_ENABLED=false");
      expect(runbook).toContain("PMXT_SHADOW_ROUTER_ENABLED=false");
    });

    it("documents restart or redeploy of startup-bound config", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/restart.*redeploy/);
    });

    it("documents verifying zero PMXT requests", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/zero.*pmxt.*request/);
    });

    it("documents optionally revoking the key", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/revok.*key/);
    });
  });

  // AC 3: In-flight leases, cohort invalidation, audit retention,
  // raw-data purge, and table teardown are documented.
  describe("AC3 — Lease drain, retention, purge, teardown", () => {
    it("documents in-flight lease drain", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/in-flight.*lease/);
    });

    it("documents cohort invalidation", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/cohort.*invalidat/);
    });

    it("documents audit retention", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("audit retention");
    });

    it("documents raw-data purge", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/raw.*data.*purge/);
    });

    it("documents table teardown", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("table teardown");
    });
  });

  // AC 4: Shadow Sentry monitoring uses a distinct slug/tags and cannot
  // change authoritative check-ins or scan status.
  describe("AC4 — Shadow Sentry monitoring isolation", () => {
    it("documents a distinct Sentry slug/tags for shadow monitoring", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/distinct.*(slug|tag)/);
    });

    it("documents that shadow monitoring cannot change authoritative check-ins", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/cannot.*change.*authoritative.*check/);
    });

    it("documents that shadow monitoring cannot change scan status", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/cannot.*change.*scan.*status/);
    });
  });

  // AC 5: Automatic stop conditions include terms changes, sidecar
  // behavior, secrets/account data in payloads, inversions/units defects,
  // cost/quota excess, and authoritative propagation.
  describe("AC5 — Automatic stop conditions", () => {
    it("documents terms changes as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/terms.*change/);
    });

    it("documents sidecar behavior as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/sidecar/);
    });

    it("documents secrets or account data in payloads as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/secret.*account.*data.*payload/);
    });

    it("documents inversions or units defects as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/inversion.*unit/);
    });

    it("documents cost or quota excess as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/cost.*quota.*excess/);
    });

    it("documents authoritative propagation as a stop condition", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/authoritative.*propagat/);
    });
  });

  // Cross-cutting: the runbook must never suggest that disabling an
  // environment variable takes effect without a process restart/redeploy.
  describe("Config change discipline", () => {
    it("documents that env var changes require restart or redeploy", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/restart.*redeploy/);
      // Must explicitly warn that disabling env vars alone is insufficient
      expect(runbook.toLowerCase()).toMatch(/disabling.*env.*not.*effective/);
    });
  });

  // Required operational sections
  describe("Required operational sections", () => {
    it("documents secret injection and rotation", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/secret.*inject.*rotat/);
    });

    it("documents worker health monitoring", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/worker.*health/);
    });

    it("documents request, cost, and retention monitoring", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/request.*cost.*retention.*monitor/);
    });

    it("documents pause and lease drain", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/pause.*lease.*drain/);
    });

    it("documents terms changes handling", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toMatch(/terms.*change/);
    });

    it("documents data purge", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("data purge");
    });

    it("documents final teardown", () => {
      runbook = readRunbook();
      expect(runbook.toLowerCase()).toContain("final teardown");
    });
  });
});
