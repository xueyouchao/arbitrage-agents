import { readFile, access } from "fs/promises";
import { join } from "path";
import { describe, expect, it } from "vitest";
import * as yaml from "yaml";

describe("CI/CD Pipeline Configuration", () => {
  it("has a CI/CD workflow file", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    await access(workflowPath);
  });

  it("CI/CD workflow is valid YAML", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    expect(parsed).toBeDefined();
    expect(parsed.name).toBe("CI/CD Pipeline");
  });

  it("CI/CD workflow has required jobs", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    
    expect(parsed.jobs).toBeDefined();
    expect(parsed.jobs.typecheck).toBeDefined();
    expect(parsed.jobs.build).toBeDefined();
    expect(parsed.jobs.test).toBeDefined();
    expect(parsed.jobs["test-integration"]).toBeDefined();
    expect(parsed.jobs["test-migrations"]).toBeDefined();
    expect(parsed.jobs["quality-gate"]).toBeDefined();
  });

  it("CI/CD workflow triggers on push and pull_request", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    
    expect(parsed.on.push).toBeDefined();
    expect(parsed.on.pull_request).toBeDefined();
  });

  it("CI/CD workflow has quality gate that depends on all test jobs", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);
    
    const qualityGate = parsed.jobs["quality-gate"];
    expect(qualityGate.needs).toContain("typecheck");
    expect(qualityGate.needs).toContain("build");
    expect(qualityGate.needs).toContain("test");
    expect(qualityGate.needs).toContain("test-integration");
    expect(qualityGate.needs).toContain("test-migrations");
  });

  it("coverage configuration has thresholds defined", async () => {
    const configPath = join(process.cwd(), "vitest.config.ts");
    const content = await readFile(configPath, "utf8");

    expect(content).toContain("thresholds");
    expect(content).toContain("lines");
    expect(content).toContain("functions");
    expect(content).toContain("branches");
    expect(content).toContain("statements");
  });

  it("deploy-production job runs migrations before the code swap and rolls back code (not the DB) on health failure", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const deploy = parsed.jobs["deploy-production"];
    expect(deploy).toBeDefined();
    // Production deploys are gated behind the quality gate and main pushes.
    expect(deploy.needs).toContain("quality-gate");
    expect(deploy.if).toContain("refs/heads/main");

    const script: string = deploy.steps[0].with.script;

    // Migrations must run AGAINST THE NEW IMAGE, not the old running
    // container. The api service bakes drizzle/*.sql into the image at
    // build time (Dockerfile `COPY . .`, no source volume mount), so
    // `docker compose exec` would run the OLD image's migration set and
    // silently skip any new migration. The safe pattern is:
    //   1. `docker compose build api`  — build the new image WITHOUT
    //      swapping the running containers (a failure here never
    //      touches the live app).
    //   2. `docker compose run --rm --no-deps api npm run db:migrate`
    //      — run migrations in a one-shot container from the NEW image.
    //   3. `docker compose up -d --build` — swap.
    const buildIdx = script.indexOf("docker compose build api");
    const migrateRunIdx = script.indexOf("docker compose run --rm --no-deps api npm run db:migrate");
    const swapIdx = script.indexOf("docker compose up -d --build");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(migrateRunIdx).toBeGreaterThan(-1);
    expect(swapIdx).toBeGreaterThan(-1);
    // Order: build new image → migrate on it → swap.
    expect(buildIdx).toBeLessThan(migrateRunIdx);
    expect(migrateRunIdx).toBeLessThan(swapIdx);

    // The old broken form — running migrations via `exec` against the
    // OLD running container, whose baked-in migration set is stale —
    // must be gone.
    expect(script).not.toContain("docker compose exec -T api npm run db:migrate");

    // Rollback records and checks out the pre-deploy SHA (not HEAD~1,
    // which can point at the wrong ref after a merge), and explicitly
    // does NOT revert the database.
    expect(script).toContain("PRE_DEPLOY_SHA=$(git rev-parse HEAD)");
    expect(script).toContain('git checkout "$PRE_DEPLOY_SHA" -- .');
    expect(script).toMatch(/NOT reverted|intentionally NOT reverted/i);
  });

  it("deploy-production health check uses a bounded retry loop (not a fixed sleep + single curl)", async () => {
    const workflowPath = join(process.cwd(), ".github/workflows/ci-cd.yml");
    const content = await readFile(workflowPath, "utf8");
    const parsed = yaml.parse(content);

    const script: string = parsed.jobs["deploy-production"].steps[0].with.script;

    // A loop construct exists (bash `for ... in ... seq` or `while ... do`).
    expect(script).toMatch(/for .* in .*\bseq\b|while .*\bdo\b/i);

    // The loop body contains a sleep (poll interval).
    expect(script).toMatch(/sleep [0-9]+/);

    // The health probe (curl /health + grep -q "ok") is INSIDE the loop body.
    // Assert the loop construct appears before the success/failure branch,
    // so the probe repeats inside the loop rather than running once after a
    // single fixed sleep.
    const loopIdx = script.search(/for .* in .*\bseq\b|while .*\bdo\b/i);
    const successIdx = script.indexOf('✅ Deployment successful');
    expect(loopIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(successIdx);

    // The curl ... /health probe must appear (it runs each iteration).
    expect(script).toMatch(/curl[^\n]*\/health/);
    expect(script).toMatch(/grep -q "ok"/);

    // The old fragile form — bare `sleep 15` immediately before the
    // "Verifying health" echo with no surrounding loop — must be gone.
    expect(script).not.toMatch(/sleep 15\s*\n\s*echo "=== Verifying health/);
  });
});
