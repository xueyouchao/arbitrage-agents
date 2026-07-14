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
      exclude: ["src/main-*.ts", "src/**/*.module.ts", "src/db/schema.ts",
        // Thin venue trading adapters — delegate to external SDKs, not unit-testable
        "src/contexts/execution/infrastructure/*-trading-client-adapter.ts",
        // Postgres execution repos — require live DB, covered by integration tests
        "src/contexts/execution/infrastructure/postgres-execution-repositories.ts",
        // Positions controller — thin HTTP wrapper, covered by its own unit test file
        "src/contexts/api/positions.controller.ts",
        // Trading domain types — type-only files, no executable functions
        "src/contexts/venues/domain/trading.ts",
        // Type-only domain files with no runtime functions
        "src/contexts/venues/domain/venue-market.ts",
        "src/contexts/arbitrage/domain/opportunity.ts",
        "src/contexts/scanner/scanner-result.ts",
        "src/contexts/scanner/scanner-repository.ts",
        "src/contexts/matching/domain/candidate-pair.ts",
        "src/contexts/llm/application/llm-evaluation.ts",
        "src/contexts/llm/application/llm-trace-reporter.ts",
        // Sentry smoke check — standalone script
        "src/sentry-monitor-smoke.ts",
        // Noop LLM provider — zero-behavior stub
        "src/contexts/llm/application/noop-llm-provider.ts",
      ],
      thresholds: {
        lines: 83,
        functions: 88,
        branches: 80,
        statements: 83
      }
    }
  }
});
