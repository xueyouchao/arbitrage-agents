import { ContractLeg, CrossVenueOpportunity, FeeModel, FeeModels, PriceLevel, probabilityWeightedFee } from "./opportunity";

/**
 * Paper-trade simulator: deterministic both-legs simulation of how an
 * opportunity would have actually traded, including partial fills and
 * adverse selection. The output is recorded alongside the canonical
 * opportunity so analysts can tell "apparent edge" from "actionable edge".
 *
 * Lives in the arbitrage domain because it depends on `CrossVenueOpportunity`
 * and the same fee/slippage primitives the calculator uses, but has no
 * dependency on persistence or scanner orchestration. The scanner calls
 * `simulate()` for each emitted opportunity and threads the result into
 * the completed-scan artifacts.
 */

export interface PaperTradeLegFill {
  averagePrice: number;
  contracts: number;
  fees: number;
  slippage: number;
}

export interface PaperTradeSimulation {
  id: string;
  opportunityId: string;
  simulatedAt: string;
  targetNotionalUsd: number;
  longLegFill: PaperTradeLegFill;
  hedgeLegFill: PaperTradeLegFill;
  adverseSelectionBps: number;
  partialFill: boolean;
  residualExposureUsd: number;
  combinedCost: number;
  grossEdge: number;
  netEdge: number;
  configVersion: string;
  calculationVersion: string;
}

export interface PaperTradeSimulatorOptions {
  /** Target notionals (USD) to simulate. Default: [5, 25, 100, executableSizeUsd] */
  targetNotionalsUsd?: number[];
  /** Adverse-selection bps applied to the hedge leg's effective price after the long leg fills. Default: 25 */
  adverseSelectionBps?: number;
  /** Optional per-venue fee model registry; falls back to `leg.feeRate` if absent. */
  feeModels?: FeeModels;
  /** Wall-clock for `simulatedAt`. Default: new Date() */
  now?: () => Date;
}

const DEFAULT_TARGET_NOTIONALS = [5, 25, 100];
const DEFAULT_ADVERSE_SELECTION_BPS = 25;
const SYMBOLIC_USD_EPSILON = 0.000001;

export class PaperTradeSimulator {
  simulate(opportunity: CrossVenueOpportunity, options: PaperTradeSimulatorOptions = {}): PaperTradeSimulation[] {
    const targets = options.targetNotionalsUsd
      ?? dedupeAndSort([...DEFAULT_TARGET_NOTIONALS, opportunity.executableSizeUsd]);
    const adverseSelectionBps = options.adverseSelectionBps ?? DEFAULT_ADVERSE_SELECTION_BPS;
    const feeModels = options.feeModels ?? {};
    const simulatedAt = (options.now ?? (() => new Date()))().toISOString();

    return targets.map((target) =>
      this.simulateOne(opportunity, target, adverseSelectionBps, feeModels, simulatedAt)
    );
  }

  private simulateOne(
    opportunity: CrossVenueOpportunity,
    targetNotionalUsd: number,
    adverseSelectionBps: number,
    feeModels: FeeModels,
    simulatedAt: string
  ): PaperTradeSimulation {
    const adverseShift = adverseSelectionBps / 10_000;
    const longFill = walkLeg(opportunity.longLeg, targetNotionalUsd, feeModels, 0);
    const hedgeFill = walkLeg(opportunity.hedgeLeg, targetNotionalUsd, feeModels, adverseShift);

    const combinedCost = round4(longFill.averagePrice + hedgeFill.averagePrice);
    const grossEdge = round4(1 - combinedCost);
    const totalFees = round4(longFill.fees + hedgeFill.fees);
    const totalSlippage = round4(longFill.slippage + hedgeFill.slippage);
    const netEdge = round4(grossEdge - totalFees - totalSlippage);
    const partialFill = !longFill.fillable || !hedgeFill.fillable;
    const residualExposureUsd = roundUsd(computeResidualUsd(targetNotionalUsd, longFill, hedgeFill));

    return {
      id: `${opportunity.id}:sim:${targetNotionalUsd}`,
      opportunityId: opportunity.id,
      simulatedAt,
      targetNotionalUsd,
      longLegFill: longFill,
      hedgeLegFill: hedgeFill,
      adverseSelectionBps,
      partialFill,
      residualExposureUsd,
      combinedCost,
      grossEdge,
      netEdge,
      configVersion: opportunity.configVersion,
      calculationVersion: opportunity.calculationVersion
    };
  }
}

interface LegFillResult extends PaperTradeLegFill {
  fillable: boolean;
}

function walkLeg(leg: ContractLeg, targetNotionalUsd: number, feeModels: FeeModels, priceMultiplierDelta: number): LegFillResult {
  const effectivePriceMultiplier = 1 + priceMultiplierDelta;
  const levels = resolveDepthLevels(leg);
  if (levels.length === 0) {
    return { averagePrice: 0, contracts: 0, fees: 0, slippage: 0, fillable: false };
  }

  let remainingUsd = targetNotionalUsd;
  let totalCost = 0;
  let totalContracts = 0;

  for (const level of levels) {
    if (remainingUsd <= 0) break;
    const effectivePrice = round4(level.price * effectivePriceMultiplier);
    if (!isFinitePrice(effectivePrice) || !Number.isFinite(level.size) || level.size <= 0) continue;
    const levelUsd = effectivePrice * level.size;
    const spendUsd = Math.min(remainingUsd, levelUsd);
    totalCost += spendUsd;
    totalContracts += spendUsd / effectivePrice;
    remainingUsd -= spendUsd;
  }

  if (totalContracts <= 0) {
    return { averagePrice: 0, contracts: 0, fees: 0, slippage: 0, fillable: false };
  }

  const averagePrice = totalCost / totalContracts;
  const feeModel = feeModels[leg.venue] ?? leg.feeModel;
  const fees = feeForPrice(averagePrice, feeModel, leg.feeRate ?? 0);
  const topOfBookPrice = levels[0].price * effectivePriceMultiplier;
  const slippage = Math.max(0, averagePrice - topOfBookPrice) * totalContracts;

  return {
    averagePrice: round4(averagePrice),
    contracts: round4(totalContracts),
    fees: round4(fees),
    slippage: round4(slippage),
    fillable: remainingUsd <= SYMBOLIC_USD_EPSILON
  };
}

function resolveDepthLevels(leg: ContractLeg): PriceLevel[] {
  if (leg.depthLevels && leg.depthLevels.length > 0) {
    return [...leg.depthLevels]
      .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.price < 1 && Number.isFinite(l.size) && l.size > 0)
      .sort((a, b) => a.price - b.price);
  }
  if (isFinitePrice(leg.askPrice) && Number.isFinite(leg.availableUsd) && leg.availableUsd > 0) {
    return [{ price: leg.askPrice, size: leg.availableUsd / leg.askPrice }];
  }
  return [];
}

function feeForPrice(price: number, feeModel: FeeModel | undefined, fallbackRate: number): number {
  if (!feeModel || feeModel.type === "flat") {
    const rate = feeModel && feeModel.type === "flat" && typeof feeModel.rate === "number" ? feeModel.rate : fallbackRate;
    return price * rate;
  }
  if (feeModel.type === "kalshi") {
    const coefficient = typeof feeModel.rate === "number" ? feeModel.rate : fallbackRate;
    return probabilityWeightedFee(price, coefficient);
  }
  if (feeModel.type === "polymarket") {
    if (feeModel.probabilityWeighted) {
      const coefficient = typeof feeModel.probabilityWeightedRate === "number" ? feeModel.probabilityWeightedRate : fallbackRate;
      return probabilityWeightedFee(price, coefficient);
    }
    const bps = feeModel.takerFeeRateBps ?? feeModel.feeRateBps ?? fallbackRate * 10_000;
    const opBps = feeModel.operatorFeeRateBps ?? 0;
    return price * ((bps + opBps) / 10_000);
  }
  return 0;
}

function computeResidualUsd(targetNotionalUsd: number, longFill: LegFillResult, hedgeFill: LegFillResult): number {
  if (longFill.fillable && hedgeFill.fillable) return 0;
  const longUnfilled = Math.max(0, targetNotionalUsd - longFill.averagePrice * longFill.contracts);
  const hedgeUnfilled = Math.max(0, targetNotionalUsd - hedgeFill.averagePrice * hedgeFill.contracts);
  return Math.max(longUnfilled, hedgeUnfilled);
}

function dedupeAndSort(values: number[]): number[] {
  return [...new Set(values)]
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
}

function isFinitePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
