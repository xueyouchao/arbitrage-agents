#!/usr/bin/env tsx
/**
 * Trigger the regime classifier on demand. Useful in CI to verify the LLM
 * call path works without booting the full bot.
 */
import { loadEnv } from "../src/infra/env.js";
loadEnv();
import { classifyRegime } from "../src/agents/regime.js";
import { log } from "../src/infra/logger.js";

async function main() {
  const state = await classifyRegime({
    realizedVol60s: 0.45,
    btcReturn15m: 0.003,
    btcReturn1h: 0.008,
    spreadBps: 4,
  });
  log.info("regime.manual", { ...state });
}

main().catch((e) => {
  log.error("regime.manual.fail", { err: String(e) });
  process.exit(1);
});
