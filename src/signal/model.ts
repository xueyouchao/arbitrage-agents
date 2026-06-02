/**
 * Fair-probability model for binary "Up by window end" markets.
 *
 * Approach: Black-Scholes binary delta, with realized vol replacing the
 * parametric vol, and the strike (K) set to the candle's open price.
 *
 *   d = (ln(S/K) - 0.5 * sigma^2 * tau) / (sigma * sqrt(tau))
 *   p_up = Phi(d)
 *
 * For a 15-min/1h horizon, the drift term is dominated by the vol term, so
 * we zero it out (consistent with academic findings for short-dated
 * binaries). The result is clipped to [0.02, 0.98] to prevent 0/1 prices.
 *
 * If the realized vol is below `volFloor`, we use the floor — this avoids
 * wildly confident probabilities during quiet markets.
 */
import type { CandleSnapshot } from "./candle.js";
import { cfg } from "../config.js";

export interface FairProbInput {
  candle: CandleSnapshot;
  volFloor?: number; // annualized
}

export interface FairProbOutput {
  pUp: number; // 0..1
  d: number; // raw z-score
  sigma: number; // annualized vol used
  tauSec: number;
}

export function fairUpProb(input: FairProbInput): FairProbOutput {
  const { candle } = input;
  const volFloor =
    input.volFloor ?? cfg.volFloor15m * Math.sqrt(365.25 * 24 * 4); // scale 15m floor to annualized
  const sigma = Math.max(candle.realizedVol60s, volFloor);
  const tauSec = Math.max(candle.tauSec, 0.001);
  const tauYear = tauSec / (365.25 * 24 * 3600);
  const S = candle.current;
  const K = candle.open;
  if (S <= 0 || K <= 0) return { pUp: 0.5, d: 0, sigma, tauSec };
  const d =
    (Math.log(S / K) - 0.5 * sigma * sigma * tauYear) / (sigma * Math.sqrt(tauYear));
  const p = phi(d);
  return { pUp: Math.max(0.02, Math.min(0.98, p)), d, sigma, tauSec };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 approximation). */
export function phi(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}
