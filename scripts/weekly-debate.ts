#!/usr/bin/env tsx
/**
 * Standalone trigger for the weekly multi-agent parameter debate.
 * Reads recent PnL from the daily logs, builds a WeeklyContext, runs the
 * debate, and writes signal/params.json. Safe to run as a cron job.
 */
import { loadEnv } from "../src/infra/env.js";
loadEnv();
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runDebate, writeParams, type WeeklyContext } from "../src/agents/debate.js";
import { log } from "../src/infra/logger.js";

interface TradeLog {
  t: string;
  msg: string;
  pnl?: number;
  edge?: number;
  side?: string;
  conditionId?: string;
}

function readRecentTrades(): TradeLog[] {
  const today = new Date().toISOString().slice(0, 10);
  const path = join("logs", `bot-${today}.ndjson`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as TradeLog;
      } catch {
        return null;
      }
    })
    .filter((r): r is TradeLog => r !== null && r.msg === "paper.resolve");
}

function summarize(): WeeklyContext {
  const trades = readRecentTrades();
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const meanEdge =
    trades.length > 0
      ? trades.reduce((s, t) => s + (t.edge ?? 0), 0) / trades.length
      : 0;
  const drawdownPct = -Math.min(0, totalPnl) / 3000;
  return {
    nowIso: new Date().toISOString(),
    weeklyPnlPct: totalPnl / 3000,
    weeklyPnlUsdc: totalPnl,
    winRate,
    tradeCount: trades.length,
    meanEdge,
    regime: "med",
    drawdownPct,
  };
}

async function main() {
  const ctx = summarize();
  log.info("weekly-debate.start", { ctx });
  const outcome = await runDebate(ctx);
  const path = writeParams(outcome);
  log.info("weekly-debate.done", { path, params: outcome.params });
}

main().catch((e) => {
  log.error("weekly-debate.fail", { err: String(e) });
  process.exit(1);
});
