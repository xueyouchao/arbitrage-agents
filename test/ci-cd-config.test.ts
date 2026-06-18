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
});
