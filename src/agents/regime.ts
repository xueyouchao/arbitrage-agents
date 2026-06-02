/**
 * Regime classifier: every 5 minutes, ask a single cheap LLM to classify the
 * current crypto vol regime (low|med|high) from a tight summary. The result
 * is written to a small JSON file that the hot path can read on next tick
 * to adjust the vol floor.
 *
 * Bounded prompt: < 500 tokens in, < 50 tokens out. Cannot blow context.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.js";
import { chat } from "./llm.js";
import { log } from "../infra/logger.js";

const SYSTEM = `You classify crypto market vol regimes. Reply with EXACTLY one word: low, med, or high.`;

export interface RegimeState {
  regime: "low" | "med" | "high";
  updatedAt: string;
  basis: string;
}

const VALID = new Set(["low", "med", "high"]);

export async function classifyRegime(metrics: {
  realizedVol60s: number;
  btcReturn15m: number;
  btcReturn1h: number;
  spreadBps: number;
}): Promise<RegimeState> {
  const user = `Realized vol (60s, annualized): ${metrics.realizedVol60s.toFixed(3)}.
15m return: ${(metrics.btcReturn15m * 100).toFixed(2)}%.
1h return: ${(metrics.btcReturn1h * 100).toFixed(2)}%.
Top-of-book spread: ${metrics.spreadBps.toFixed(0)} bps.
Classify the current vol regime. Reply with one word.`;
  let regime: RegimeState["regime"] = "med";
  let basis = "fallback";
  try {
    const res = await chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      { model: cfg.regimeModel, temperature: 0.0, maxTokens: 5 },
    );
    const w = res.content.trim().toLowerCase().split(/\s+/)[0] ?? "";
    if (VALID.has(w)) {
      regime = w as RegimeState["regime"];
      basis = `model=${res.model} elapsed=${res.elapsedMs}ms`;
    }
  } catch (e) {
    log.warn("regime.fail", { err: String(e) });
  }
  const state: RegimeState = { regime, updatedAt: new Date().toISOString(), basis };
  writeRegime(state);
  return state;
}

export function writeRegime(state: RegimeState) {
  const dir = "signal";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "regime.json"), JSON.stringify(state, null, 2));
}

export function readRegime(): RegimeState | null {
  const p = join("signal", "regime.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RegimeState;
  } catch {
    return null;
  }
}
