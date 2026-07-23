import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PMXT production composition", () => {
  it("keeps the authoritative ScannerModule free of PMXT shadow providers", async () => {
    const scannerModule = await readFile(
      join(process.cwd(), "src/contexts/scanner/scanner.module.ts"),
      "utf8"
    );

    expect(scannerModule).not.toContain("PMXT_SHADOW_RUNNER");
    expect(scannerModule).not.toContain("PostgresPmxtShadowLeaseRepository");
    expect(scannerModule).not.toContain("async () => []");
    expect(scannerModule).not.toContain("async () => ({})");
  });

  it("boots the PMXT entrypoint from a dedicated app module", async () => {
    const entrypoint = await readFile(
      join(process.cwd(), "src/main-pmxt-shadow.ts"),
      "utf8"
    );
    const appModule = await readFile(
      join(process.cwd(), "src/pmxt-shadow-app.module.ts"),
      "utf8"
    );

    expect(entrypoint).toContain("PmxtShadowAppModule");
    expect(entrypoint).not.toContain("WorkerAppModule");
    expect(appModule).toContain("PmxtShadowModule");
    expect(appModule).not.toContain("ScannerModule");
    expect(appModule).not.toContain("WorkerAppModule");
    expect(appModule).not.toContain("WorkerScanRunner");
  });
});
