import { config } from "dotenv";
import { Pool } from "pg";
import { PaperTradeDashboard } from "./paper-trade-dashboard";
import { PostgresReadRepositories } from "../src/contexts/api/postgres-read-repositories";
import { PaperTradeSimulationReadService } from "../src/contexts/api/read-models";
import { loadAppConfig } from "../src/config/app-config";

config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

function usage() {
  console.log("Usage: npx ts-node runbook/paper-trade-runbook.ts <opportunity-id> [target-notional,...]");
  console.log("  opportunity-id   UUID of the opportunity to analyze");
  console.log("  target-notional  Comma-separated USD notionals (default: all stored simulations)");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  const opportunityId = args[0];
  const notionalsArg = args[1];

  const appConfig = loadAppConfig({ DATABASE_URL });
  const pool = new Pool({ connectionString: DATABASE_URL });
  const repositories = new PostgresReadRepositories(appConfig);
  const paperTradeService = new PaperTradeSimulationReadService(repositories);

  try {
    const opportunity = await repositories.getOpportunity(opportunityId);
    if (!opportunity) {
      console.error(`Opportunity ${opportunityId} not found`);
      process.exit(1);
    }

    let simulations = await paperTradeService.listPaperTradeSimulations(opportunityId);

    if (notionalsArg) {
      const requested = notionalsArg
        .split(",")
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const requestedSet = new Set(requested);
      simulations = simulations.filter((s) => requestedSet.has(s.targetNotionalUsd));
    }

    const dashboard = new PaperTradeDashboard();
    console.log(dashboard.render(opportunity, simulations));
  } finally {
    await pool.end();
    await repositories.onModuleDestroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
