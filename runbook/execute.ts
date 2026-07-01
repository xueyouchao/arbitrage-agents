import { config } from "dotenv";
import { Pool } from "pg";
import { loadAppConfig } from "../src/config/app-config";
import { KalshiTradingClient } from "../src/contexts/venues/infrastructure/kalshi-trading-client";
import { PolymarketTradingClient } from "../src/contexts/venues/infrastructure/polymarket-trading-client";
import { PostgresReadRepositories } from "../src/contexts/api/postgres-read-repositories";
import {
  ExecutionOrchestrator,
  AlreadyExecutedError,
  RiskRejectedError,
  type TradingClients
} from "../src/contexts/execution/application/execution-orchestrator";
import { KalshiTradingClientAdapter } from "../src/contexts/execution/infrastructure/kalshi-trading-client-adapter";
import { PolymarketTradingClientAdapter } from "../src/contexts/execution/infrastructure/polymarket-trading-client-adapter";
import { PostgresExecutionRepositories } from "../src/contexts/execution/infrastructure/postgres-execution-repositories";
import { RiskManager } from "../src/contexts/execution/application/risk-manager";
import type { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import type { OrderSigner } from "../src/contexts/venues/domain/trading";

config();

function usage(): void {
  console.log("Usage: npx ts-node runbook/execute.ts <opportunity-id>");
  console.log("  Loads an opportunity by id from the DB and executes both legs.");
  console.log("  Requires DATABASE_URL and Kalshi/Polymarket trading credentials in env.");
  process.exit(1);
}

/**
 * Constructs the OrderSigner for the Polymarket CLOB. ethers.js is not yet a
 * dependency of this repo, so we cannot sign orders here. Throw a clear error
 * directing the caller to wire up ethers.js rather than silently sending
 * unsigned orders.
 */
function buildPolymarketSigner(): OrderSigner {
  throw new Error(
    "Polymarket order signing requires ethers.js integration. POLY_PRIVATE_KEY is set but no signer is available — implement an ethers.js Wallet-based OrderSigner to sign CLOB orders."
  );
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

  // NOTE: This runbook creates its own pg Pool rather than using the shared
  // DATABASE_POOL from src/db. This is acceptable for a standalone CLI
  // runbook. When the execution module is wired into the NestJS app, it
  // should use the shared pool (src/db/database-pool.ts) instead of
  // constructing a new one here. See PostgresExecutionRepositories for the
  // production persistence path.
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
          walletAddress: appConfig.polyWalletAddress,
          // Will throw a clear error explaining ethers.js integration is needed.
          signer: buildPolymarketSigner()
        })
      )
    };

    const repos = new PostgresExecutionRepositories(pool);
    const orchestrator = new ExecutionOrchestrator(repos, {
      riskManager: new RiskManager(),
      totalOpenNotional: 0,
      maxCapitalDeployed: appConfig.maxCapitalDeployedUsd
    });

    console.log(`Executing opportunity ${opportunity.id}`);
    console.log(`  longLeg : ${opportunity.longLeg.venue} ${opportunity.longLeg.marketId} ${opportunity.longLeg.side} @ ${opportunity.longLeg.askPrice}`);
    console.log(`  hedgeLeg: ${opportunity.hedgeLeg.venue} ${opportunity.hedgeLeg.marketId} ${opportunity.hedgeLeg.side} @ ${opportunity.hedgeLeg.askPrice}`);

    let result;
    try {
      result = await orchestrator.execute(opportunity, clients);
    } catch (error) {
      if (error instanceof AlreadyExecutedError) {
        console.log(`Already executed: ${error.message}`);
        return;
      }
      if (error instanceof RiskRejectedError) {
        console.log(`Risk rejected: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }

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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});