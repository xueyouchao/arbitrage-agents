/**
 * Weekly parameter debate. Fans the same brief out to all `cfg.debateModels`
 * (4 ollama cloud models), each returns a JSON parameter proposal, and a
 * majority-wins judge picks the consensus. The output is written to
 * `signal/params.json` (consumed by the hot path on next boot).
 *
 * Key design: the brief is bounded to ~300 tokens of input + ~200 tokens of
 * output per model. Total context under 4k tokens per call, no possibility
 * of context explosion.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cfg } from "../config.js";
import { fanOut, type ChatResult } from "./llm.js";
import { log } from "../infra/logger.js";

export interface ParamProposal {
  edgeThreshold: number; // 0.005..0.10
  volFloor15m: number; // 0.001..0.02
  tauFracGate: number; // 0.2..0.9
  sizePct: number; // 0.005..0.05
  rationale: string; // < 200 chars
  model: string;
}

const SYSTEM = `You are a quant researcher tuning a Polymarket latency-arb bot.
Reply with a single JSON object matching this TypeScript interface (no prose, no markdown):
{
  "edgeThreshold": number,    // fair - market gap required to trade, 0.005..0.10
  "volFloor15m": number,      // minimum realized vol (15-min-normalized), 0.001..0.02
  "tauFracGate": number,      // only trade when tau/T < this, 0.2..0.9
  "sizePct": number,          // fraction of bankroll per trade, 0.005..0.05
  "rationale": string         // < 200 chars
}
Output ONLY the JSON.`;

const USER_TEMPLATE = (ctx: WeeklyContext) => `Recent context (UTC ${ctx.nowIso}):
- Last 7d PnL: ${ctx.weeklyPnlPct.toFixed(3)}% (${ctx.weeklyPnlUsdc.toFixed(2)} USDC)
- Win rate: ${(ctx.winRate * 100).toFixed(1)}% over ${ctx.tradeCount} trades
- Mean edge captured: ${(ctx.meanEdge * 100).toFixed(2)}%
- Realized vol regime: ${ctx.regime} (low|med|high)
- Drawdown this week: ${(ctx.drawdownPct * 100).toFixed(2)}% of bankroll

Propose a parameter set. Return ONLY JSON.`;

export interface WeeklyContext {
  nowIso: string;
  weeklyPnlPct: number;
  weeklyPnlUsdc: number;
  winRate: number;
  tradeCount: number;
  meanEdge: number;
  regime: "low" | "med" | "high";
  drawdownPct: number;
}

const PROPOSAL_RE = /\{[\s\S]*?"edgeThreshold"[\s\S]*?\}/;

function safeParse(raw: string, model: string): ParamProposal | null {
  const m = raw.match(PROPOSAL_RE);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const p: ParamProposal = {
      edgeThreshold: Number(obj.edgeThreshold),
      volFloor15m: Number(obj.volFloor15m),
      tauFracGate: Number(obj.tauFracGate),
      sizePct: Number(obj.sizePct),
      rationale: String(obj.rationale ?? "").slice(0, 200),
      model,
    };
    p.edgeThreshold = clamp(p.edgeThreshold, 0.005, 0.10);
    p.volFloor15m = clamp(p.volFloor15m, 0.001, 0.02);
    p.tauFracGate = clamp(p.tauFracGate, 0.2, 0.9);
    p.sizePct = clamp(p.sizePct, 0.005, 0.05);
    return p;
  } catch {
    return null;
  }
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface DebateOutcome {
  params: ParamProposal;
  raw: ChatResult[];
  consensusRationale: string;
}

export async function runDebate(ctx: WeeklyContext): Promise<DebateOutcome> {
  const userMsg = USER_TEMPLATE(ctx);
  const results = await fanOut(
    cfg.debateModels,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.3, maxTokens: 250 },
  );

  const proposals = results
    .map((r) => safeParse(r.content, r.model))
    .filter((p): p is ParamProposal => p !== null);

  log.info("debate.proposals", {
    n: proposals.length,
    models: proposals.map((p) => p.model),
  });

  if (proposals.length === 0) {
    const fallback: ParamProposal = {
      edgeThreshold: cfg.edgeThreshold,
      volFloor15m: cfg.volFloor15m,
      tauFracGate: cfg.tauFracGate,
      sizePct: cfg.maxTradePct,
      rationale: "no valid proposals; keeping current",
      model: "fallback",
    };
    return { params: fallback, raw: results, consensusRationale: fallback.rationale };
  }

  const consensus: ParamProposal = {
    edgeThreshold: median(proposals.map((p) => p.edgeThreshold)),
    volFloor15m: median(proposals.map((p) => p.volFloor15m)),
    tauFracGate: median(proposals.map((p) => p.tauFracGate)),
    sizePct: median(proposals.map((p) => p.sizePct)),
    rationale: `median of ${proposals.length} models`,
    model: "consensus",
  };

  return {
    params: consensus,
    raw: results,
    consensusRationale: consensus.rationale,
  };
}

export function writeParams(outcome: DebateOutcome, dir = "signal"): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "params.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    params: outcome.params,
    raw: outcome.raw.map((r) => ({ model: r.model, content: r.content.slice(0, 500) })),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  log.info("debate.wrote", { path });
  return path;
}
