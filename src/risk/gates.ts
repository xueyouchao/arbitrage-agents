/**
 * Risk gates: a stack of pure predicates. Each gate returns either
 * { ok: true, sized } or { ok: false, reason }.
 *
 * The orchestrator runs all gates in order; the first failure halts the trade.
 * State is tracked in-memory and reset daily/weekly.
 */
import { cfg } from "../config.js";
import type { Signal } from "../signal/edge.js";

export interface RiskState {
  bankrollUsdc: number;
  openPositions: number;
  intradayPnl: number; // realized + unrealized delta vs day-start bankroll
  weeklyReturns: number[]; // per-trade returns (decimal)
  dayStart: number; // ms epoch
  weekStart: number; // ms epoch
  killSwitch: boolean; // global halt
}

const state: RiskState = {
  bankrollUsdc: cfg.bankrollUsdc,
  openPositions: 0,
  intradayPnl: 0,
  weeklyReturns: [],
  dayStart: startOfDayMs(),
  weekStart: startOfWeekMs(),
  killSwitch: false,
};

export function getState(): Readonly<RiskState> {
  return state;
}

export function resetForBacktest(startBankroll: number) {
  state.bankrollUsdc = startBankroll;
  state.openPositions = 0;
  state.intradayPnl = 0;
  state.weeklyReturns = [];
  state.dayStart = startOfDayMs();
  state.weekStart = startOfWeekMs();
  state.killSwitch = false;
}

export function recordFill(side: "buy" | "sell", _notionalUsdc: number) {
  if (side === "buy") state.openPositions += 1;
  else state.openPositions = Math.max(0, state.openPositions - 1);
}

export function recordPnl(pnlUsdc: number) {
  state.intradayPnl += pnlUsdc;
  if (state.bankrollUsdc > 0) {
    state.weeklyReturns.push(pnlUsdc / state.bankrollUsdc);
  }
}

export function triggerKillSwitch(reason: string) {
  state.killSwitch = true;
  // eslint-disable-next-line no-console
  console.warn(`[risk] KILL SWITCH: ${reason}`);
}

export interface GateResult {
  ok: boolean;
  reason?: string;
  sizedUsdc?: number;
}

export function positionSize(_signal: Signal): number {
  const cap = state.bankrollUsdc * cfg.maxTradePct;
  return Math.max(0, Math.min(cap, 1000));
}

export function checkAll(signal: Signal): GateResult {
  if (state.killSwitch) return { ok: false, reason: "kill_switch_active" };
  rolloverCheck();
  if (state.intradayPnl <= -state.bankrollUsdc * cfg.dailyDrawdownPct) {
    return { ok: false, reason: "daily_drawdown_exceeded" };
  }
  if (state.openPositions >= cfg.maxOpenPositions) {
    return { ok: false, reason: "max_open_positions" };
  }
  if (signal.edge < cfg.edgeThreshold) {
    return { ok: false, reason: "edge_below_threshold" };
  }
  if (signal.tauSec <= 0) {
    return { ok: false, reason: "market_expired" };
  }
  const sized = positionSize(signal);
  if (sized <= 0) return { ok: false, reason: "zero_size" };
  return { ok: true, sizedUsdc: sized };
}

export function weeklySharpe(): number {
  if (state.weeklyReturns.length < 3) return 0;
  const mean = state.weeklyReturns.reduce((s, x) => s + x, 0) / state.weeklyReturns.length;
  const variance =
    state.weeklyReturns.reduce((s, x) => s + (x - mean) ** 2, 0) /
    (state.weeklyReturns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / sd : 0;
}

function rolloverCheck() {
  const now = Date.now();
  if (now - state.dayStart > 24 * 3600_000) {
    state.intradayPnl = 0;
    state.dayStart = startOfDayMs();
  }
  if (now - state.weekStart > 7 * 24 * 3600_000) {
    state.weeklyReturns = [];
    state.weekStart = startOfWeekMs();
  }
  if (weeklySharpe() < cfg.weeklyMinSharpe && state.weeklyReturns.length >= 10) {
    triggerKillSwitch(`weekly_sharpe<${cfg.weeklyMinSharpe}`);
  }
}

function startOfDayMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeekMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const shift = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.getTime();
}
