/**
 * Forensics agent: cheap, fast (one model: cfg.forensicsModel) post-trade
 * explanation for losing fills. Writes to logs/forensics/YYYY-MM-DD.ndjson.
 * Skips winners to save tokens and to keep the log signal-rich.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.js";
import { chat } from "./llm.js";
import type { Fill } from "../paper/runner.js";
import { log } from "../infra/logger.js";

const SYSTEM = `You are a post-trade analyst. Given a single losing trade on a Polymarket binary "Up/Down" crypto market, write a 1-sentence (<= 200 chars) hypothesis for why the trade lost. Be specific. Output one sentence only.`;

export async function analyzeLoss(fill: Fill): Promise<string> {
  if (fill.resolution?.won !== false) return "";
  const sig = fill.signal;
  const user = `Trade: ${sig.asset} ${sig.horizon} ${sig.side.toUpperCase()}.
Edge at entry: ${(sig.edge * 100).toFixed(2)}%. Fair: ${sig.fair.toFixed(3)} vs market: ${sig.market.toFixed(3)}.
Vol regime sigma: ${sig.sigma.toFixed(3)}. Tau: ${sig.tauSec.toFixed(0)}s.
Size: $${fill.sizeUsdc.toFixed(0)} at ${fill.fillPrice.toFixed(3)}.`;
  let summary = "";
  try {
    const res = await chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      { model: cfg.forensicsModel, temperature: 0.2, maxTokens: 80 },
    );
    summary = res.content.trim().slice(0, 300);
  } catch (e) {
    summary = `forensics-failed: ${String(e)}`;
  }
  appendForensic({
    t: new Date().toISOString(),
    conditionId: fill.conditionId,
    side: sig.side,
    edge: sig.edge,
    pnl: fill.resolution ? -fill.sizeUsdc : 0,
    summary,
  });
  log.info("forensics", { conditionId: fill.conditionId, summary });
  return summary;
}

function appendForensic(row: object) {
  const dir = "logs/forensics";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${today}.ndjson`);
  appendFileSync(path, JSON.stringify(row) + "\n");
}
