import { config } from "dotenv";
import { Pool } from "pg";
import { loadAppConfig } from "../src/config/app-config";
import { KalshiTradingClient } from "../src/contexts/venues/infrastructure/kalshi-trading-client";
import { PolymarketTradingClient } from "../src/contexts/venues/infrastructure/polymarket-trading-client";
import { PostgresReadRepositories } from "../src/contexts/api/postgres-read-repositories";
import {
  ExecutionOrchestrator,
  type TradingClients
} from "../src/contexts/execution/application/execution-orchestrator";
import { KalshiTradingClientAdapter } from "../src/contexts/execution/infrastructure/kalshi-trading-client-adapter";
import { PolymarketTradingClientAdapter } from "../src/contexts/execution/infrastructure/polymarket-trading-client-adapter";
import { PostgresExecutionRepositories } from "../src/contexts/execution/infrastructure/postgres-execution-repositories";
import type { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";

config();

function usage(): void {
  console.log("Usage: npx ts-node runbook/execute.ts <opportunity-id>");
  console.log("  Loads an opportunity by id from the DB and executes both legs.");
  console.log("  Requires DATABASE_URL and Kalshi/Polymarket trading credentials in env.");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
  }
  const opportunityId = args[0];

  const appConfig = loadAppConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL });
  if (!appConfig.databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: appConfig.databaseUrl });
  const readRepos = new PostgresReadRepositories(pool);

  try {
    const readModel = await readRepos.getOpportunity(opportunityId);
    if (!readModel) {
      console.error(`Opportunity ${opportunityId} not found`);
      process.exit(1);
    }
    // The read model is structurally compatible with CrossVenueOpportunity.
    const opportunity = readModel as unknown as CrossVenueOpportunity;

    if (!appConfig.kalshiApiKeyId || !appConfig.kalshiPrivateKey) {
      console.error("KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY are required to execute");
      process.exit(1);
    }
    if (!appConfig.polyPrivateKey || !appConfig.polyWalletAddress) {
      console.error("POLY_PRIVATE_KEY and POLY_WALLET_ADDRESS are required to execute");
      process.exit(1);
    }

    const clients: TradingClients = {
      kalshi: new KalshiTradingClientAdapter(
        new KalshiTradingClient({
          apiKeyId: appConfig.kalshiApiKeyId,
          privateKey: appConfig.kalshiPrivateKey
        })
      ),
      polymarket: new PolymarketTradingClientAdapter(
        new PolymarketTradingClient({
          privateKey: appConfig.polyPrivateKey,
          walletAddress: appConfig.polyWalletAddress
        })
      )
    };

    const repos = new PostgresExecutionRepositories(pool);
    const orchestrator = new ExecutionOrchestrator(repos);

    console.log(`Executing opportunity ${opportunity.id}`);
    console.log(`  longLeg : ${opportunity.longLeg.venue} ${opportunity.longLeg.marketId} ${opportunity.longLeg.side} @ ${opportunity.longLeg.askPrice}`);
    console.log(`  hedgeLeg: ${opportunity.hedgeLeg.venue} ${opportunity.hedgeLeg.marketId} ${opportunity.hedgeLeg.side} @ ${opportunity.hedgeLeg.askPrice}`);

    const result = await orchestrator.execute(opportunity, clients);

    console.log("--- result ---");
    if (result.position) {
      console.log(`position: ${result.position.status} (id=${result.position.id})`);
      console.log(`  kalshi order : ${result.position.kalshiOrderId ?? "(none)"}`);
      console.log(`  poly order   : ${result.position.polyOrderId ?? "(none)"}`);
    } else {
      console.log("position: none (both legs failed)");
    }
    console.log(`  kalshi leg   : filled=${result.legs.kalshi.filled} orderId=${result.legs.kalshi.orderId || "(none)"}${result.legs.kalshi.error ? ` error=${result.legs.kalshi.error}` : ""}`);
    console.log(`  polymarket leg: filled=${result.legs.polymarket.filled} orderId=${result.legs.polymarket.orderId || "(none)"}${result.legs.polymarket.error ? ` error=${result.legs.polymarket.error}` : ""}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});