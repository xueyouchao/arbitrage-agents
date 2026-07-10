import { ContractSide, GateResult, PriceLevel, RiskStructure } from "./opportunity";

// ADR-0002 §3.3 exit-gate configuration.
// All tunables are function parameters with documented defaults so T6 can later
// wire AppConfig into them without changing the evaluator signature.
export interface ExitGateConfig {
  // Minimum margin required beyond estimated exit costs (ADR §3.1, §3.3).
  minMargin: number;
  // Liquidity haircut applied to the surviving-leg book depth (ADR §3.3).
  depthHaircut: number;
  // Per-hour decay applied to the hold expected value to proxy gap length (ADR §6 Open Question #1).
  gapDecayPerHour: number;
  // Maximum gap decay so the hold EV never collapses below 50% of mid (ADR §6 Open Question #1).
  gapDecayMax: number;
  // Fee rate on the surviving-leg sell, as a fraction of price (ADR §3.3 exitCost component).
  sellFeeRate: number;
  // Estimated half-spread as a fraction of price (ADR §3.3 exitCost component).
  estimatedSpreadRate: number;
  // Estimated slippage as a per-share cost (dollars per share sold), NOT a fraction of
  // price. ADR §3.3 makes slippage scale with shares sold (size), while sellFee and
  // estimatedSpread scale with price. Named "...PerShare" so the unit is explicit and
  // not confused with the price-fraction rates above.
  estimatedSlippagePerShare: number;
}

// Defaults chosen to match ADR-0002 §3.3 and the simple gap-length proxy from
// §6 Open Question #1. Override via ExitGateInput.config.
export const DEFAULT_EXIT_GATE_CONFIG: ExitGateConfig = {
  minMargin: 0.005,
  depthHaircut: 0.25,
  gapDecayPerHour: 0.02,
  gapDecayMax: 0.5,
  sellFeeRate: 0.01,
  estimatedSpreadRate: 0.01,
  estimatedSlippagePerShare: 0.005,
};

export interface ExitGateInput {
  // Risk structure stamped at detection time (T2). Carries dtHours, payoffType,
  // earlyLeg / survivingLeg and basisRiskClass.
  riskStructure: RiskStructure;
  // Surviving-leg book snapshot captured at t1.
  survivingLegBook: {
    marketId: string;
    // The side we hold and would sell (YES or NO).
    side: ContractSide;
    // Best bid for the held side at t1 — this is lockValue per share.
    bidPrice: number;
    // Best ask for the held side at t1 — used only for mid/EV estimation.
    askPrice: number;
    // Bid depth ladder for the held side, best-first.
    depth: PriceLevel[];
  };
  // Number of shares held on the surviving leg.
  positionSize: number;
  // Optional overrides merged onto DEFAULT_EXIT_GATE_CONFIG.
  config?: Partial<ExitGateConfig>;
}

export interface ExitGateResult {
  // Value realized if we sell the recommended size at the recommended bid.
  lockValue: number;
  // Modeled expected value of holding one share to t2 (per share).
  holdExpectedValue: number;
  // Estimated cost to exit one share: sellFee + estimatedSpread + estimatedSlippage.
  exitCost: number;
  // "pass" iff both exit-cost and liquidity gates pass.
  gateResult: GateResult;
  // The bid price we would sell at (lockValue per share).
  recommendedSellPrice: number;
  // Liquidity-capped recommended sell size.
  recommendedSellSize: number;
  // Human-readable audit string citing gates, inputs and computed values.
  reasoning: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// toFixed wrapper that tolerates non-finite values: Number.prototype.toFixed
// throws RangeError on Infinity, so route any NaN/Infinity through a plain
// String() coercion instead of crashing the evaluator on a malformed book.
function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : String(value);
}

// ADR §3.3: available depth is the cumulative size on the held-side bid ladder,
// ignoring levels with non-finite/non-positive sizes. Best-level-only would
// understate depth for multi-level books and fail the gate prematurely.
function cumulativeDepth(levels: PriceLevel[] | undefined): number {
  if (!levels || levels.length === 0) return 0;
  let total = 0;
  for (const level of levels) {
    if (level && Number.isFinite(level.size) && level.size > 0) {
      total += level.size;
    }
  }
  return total;
}

/**
 * Evaluate the ADR-0002 §3.1 / §3.3 conditional exit gate at t1.
 *
 * Pure decision function: no trading client, no I/O, no dependency injection.
 * Sells the surviving leg only when BOTH of the following hold:
 *   1. exit-cost gate: recommendedSellPrice - holdExpectedValue > exitCost + minMargin
 *   2. liquidity gate: recommendedSellSize > 0
 *
 * holdExpectedValue uses the §6 Open Question #1 SIMPLE PROXY:
 *   survivingLegMid * (1 - gapDecay)
 * where gapDecay = clamp(dtHours * gapDecayPerHour, 0, gapDecayMax). The mid is
 * discounted by the gap decay — not a probability-weighted payoff. This is
 * intentionally a minimal gap-length proxy and will be replaced by a
 * realized-vol/probability model once calibration data is available.
 */
export function evaluateExitGate(input: ExitGateInput): ExitGateResult {
  const config: ExitGateConfig = {
    ...DEFAULT_EXIT_GATE_CONFIG,
    ...input.config,
  };

  const book = input.survivingLegBook;
  const positionSize = input.positionSize;

  // Recommended sell price is the best bid available at t1.
  const recommendedSellPrice = book.bidPrice;

  // ADR §3.3 liquidity gate: available depth is the CUMULATIVE book depth on the
  // held side (sum of depth ladder sizes), not just the best level. The haircut
  // caps the sell size at depthHaircut × availableDepth so a rescue never dumps
  // the full position into a thin/inverted book.
  const availableDepth = cumulativeDepth(book.depth);

  // Fail fast on invalid inputs (NaN/Infinity prices, non-positive position)
  // so a malformed book never produces a silently-wrong pass. ADR §5 Risks.
  const inputsValid =
    Number.isFinite(recommendedSellPrice) &&
    Number.isFinite(book.askPrice) &&
    Number.isFinite(availableDepth) &&
    Number.isFinite(positionSize) &&
    recommendedSellPrice > 0 &&
    positionSize > 0;

  const recommendedSellSize =
    !inputsValid || availableDepth <= 0
      ? 0
      : Math.min(positionSize, config.depthHaircut * availableDepth);

  // Total value unlocked if the recommended size is sold at the bid.
  const lockValue = recommendedSellPrice * recommendedSellSize;

  // ADR §3.3 exitCost = sellFee + estimatedSpread + estimatedSlippage, per share.
  // Fee and spread scale with price; slippage scales with shares sold (per share).
  const exitCost =
    recommendedSellPrice *
      (config.sellFeeRate + config.estimatedSpreadRate) +
    config.estimatedSlippagePerShare;

  // ADR §6 Open Question #1 simple proxy: surviving-leg mid discounted by a
  // clamped gap-decay factor. Replace with a realized-vol model once calibrated.
  const survivingLegMid = (book.bidPrice + book.askPrice) / 2;
  const gapDecay = clamp(
    input.riskStructure.dtHours * config.gapDecayPerHour,
    0,
    config.gapDecayMax,
  );
  const holdExpectedValue = Number.isFinite(survivingLegMid)
    ? survivingLegMid * (1 - gapDecay)
    : 0;

  // Exit-cost gate: only sell when the locked value clearly exceeds holding value
  // by more than exit costs plus the minimum margin.
  const costGateMargin = recommendedSellPrice - holdExpectedValue;
  const costGateThreshold = exitCost + config.minMargin;
  const costGatePass = inputsValid && costGateMargin > costGateThreshold;

  // Liquidity gate: we must have some depth to sell into.
  const liquidityGatePass = recommendedSellSize > 0;

  const gateResult: GateResult =
    costGatePass && liquidityGatePass ? "pass" : "fail";

  const reasoningParts: string[] = [];
  if (!inputsValid) {
    reasoningParts.push(
      `input guard: bidPrice=${recommendedSellPrice} askPrice=${book.askPrice} depth=${availableDepth} position=${positionSize} invalid → FAIL`,
    );
  } else if (recommendedSellSize === 0) {
    reasoningParts.push(
      `liquidity gate: no liquidity (availableDepth=${availableDepth}) → FAIL`,
    );
  }
  // Only emit the numeric exit-cost-gate line when inputs are finite:
  // Number.prototype.toFixed throws RangeError on Infinity, so a malformed
  // book (NaN/Infinity bid/ask from an upstream parse bug) would otherwise
  // crash the evaluator instead of returning a safe fail.
  if (inputsValid) {
    reasoningParts.push(
      `exit-cost gate: lockPerShare=${fmt(recommendedSellPrice)} holdEV=${fmt(holdExpectedValue)} exitCost=${fmt(exitCost)} minMargin=${fmt(config.minMargin)} → margin ${fmt(costGateMargin)} ${costGatePass ? ">" : "<="} threshold ${fmt(costGateThreshold)} ${costGatePass ? "PASS" : "FAIL"}`,
    );
  }
  if (recommendedSellSize > 0) {
    reasoningParts.push(
      `liquidity gate: depth=${availableDepth} haircut=${config.depthHaircut} size=${recommendedSellSize} > 0 ${liquidityGatePass ? "PASS" : "FAIL"}`,
    );
  }

  return {
    lockValue,
    holdExpectedValue,
    exitCost,
    gateResult,
    recommendedSellPrice,
    recommendedSellSize,
    reasoning: reasoningParts.join("; "),
  };
}
