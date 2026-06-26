import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/main-*.ts", "src/**/*.module.ts", "src/db/schema.ts"],
      thresholds: {
        lines: 82,
        functions: 90,
        branches: 80,
        statements: 82
      }
    }
  }
});
