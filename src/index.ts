#!/usr/bin/env node
/**
 * Entry point. Loads .env, starts feeds, starts the hot loop, and registers
 * a graceful shutdown handler. In paper mode (default), no private key is
 * required and all trades are simulated.
 */
import { loadEnv } from "./infra/env.js";
loadEnv();

import { cfg } from "./config.js";
import { log } from "./infra/logger.js";
import { startBinance, stopBinance, updates as bUpdates } from "./feeds/binance.js";
import { startCoinbase, stopCoinbase, updates as cUpdates } from "./feeds/coinbase.js";
import { startPolymarket, stopPolymarket } from "./feeds/polymarket.js";
import { startLoop } from "./orchestrator/tick.js";
import { getState } from "./risk/gates.js";

async function main() {
  log.info("boot", {
    mode: cfg.mode,
    bankroll: cfg.bankrollUsdc,
    ollama: cfg.ollamaBaseUrl,
    debateModels: cfg.debateModels,
  });

  startBinance();
  startCoinbase();
  await startPolymarket();
  const stopLoop = startLoop();

  const heartbeat = setInterval(() => {
    log.info("heartbeat", {
      binanceUpdates:
        bUpdates("BTCUSDT") + bUpdates("ETHUSDT") + bUpdates("SOLUSDT"),
      coinbaseUpdates:
        cUpdates("BTC-USD") + cUpdates("ETH-USD") + cUpdates("SOL-USD"),
      state: getState(),
    });
  }, 30_000);

  const shutdown = (sig: string) => {
    log.info("shutdown", { sig });
    clearInterval(heartbeat);
    stopLoop();
    stopBinance();
    stopCoinbase();
    stopPolymarket();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("boot.fail", { err: String(e) });
  process.exit(1);
});
