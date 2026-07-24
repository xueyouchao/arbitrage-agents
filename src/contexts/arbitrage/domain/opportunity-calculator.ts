import { CandidatePair, EquivalenceDecision } from "../../matching/domain/candidate-pair";
import { NormalizedMarket, Venue, VENUES } from "../../matching/domain/normalized-market";
import { resolvePolymarketFeeRate } from "../../venues/domain/polymarket-fee-resolver";
import { classifyRiskStructure } from "./risk-structure-classifier";
import { ContractLeg, ContractSide, CrossVenueOpportunity, FeeModel, FeeModels, MarketBook, NotionalEdge, PriceLevel, RiskLevel, RiskStructure } from "./opportunity";

export type FeeSource = "config" | "market-payload";

export interface OpportunityCalculatorOptions {
  feeRate: number;
  slippageRate: number;
  now: string;
  maxBookAgeMs: number;
  minNetEdge: number;
  profitabilityBuffer: number;
  targetNotionalsUsd: number[];
  venueFeeRates: VenueFeeRates;
  venueSlippageRates: VenueSlippageRates;
  feeModels: FeeModels;
  /**
   * Where fee rates come from.
   * - "config" (default): use venueFeeRates / feeRate.
   * - "market-payload": read per-market fee schedules from each book's
   *   rawPayload (e.g. Polymarket crypto feeSchedule.rate) and apply them per
   *   side. Explicit feeModels still take precedence when provided.
   */
  feeSource: FeeSource;
  calculationVersion: string;
  configVersion: string;
  previousDetectedAt?: string;
}

type SideRates = Partial<Record<ContractSide, number>>;
type VenueFeeRates = Partial<Record<Venue, SideRates>>;
type VenueSlippageRates = Partial<Record<Venue, SideRates>>;

type KnownVenue = Extract<Venue, "kalshi" | "polymarket">;
type AssertNoUnhandledDefaultVenue<T extends never> = T;
type _DefaultVenueCoverage = AssertNoUnhandledDefaultVenue<Exclude<Venue, KnownVenue>>;

const KNOWN_VENUES: readonly KnownVenue[] = ["kalshi", "polymarket"];

const DEFAULT_OPTIONS: OpportunityCalculatorOptions = {
  // ADR-0002 §3.3: realistic default cost models. Kalshi and Polymarket crypto
  // price-level markets use a probability-weighted fee: rate * price * (1 - price).
  // The coefficient defaults to 0.07 (7% at-the-money) for taker fills; the
  // Kalshi model supports a maker discount via the feeModel registry. Slippage
  // is kept as a conservative per-side flat rate but is modeled from orderbook
  // impact in depth-walked simulations.
  feeRate: 0,
  slippageRate: 0.005,
  now: "",
  maxBookAgeMs: 60_000,
  minNetEdge: 0,
  profitabilityBuffer: 0,
  targetNotionalsUsd: [5, 25, 100],
  venueFeeRates: {
    kalshi: { YES: 0, NO: 0 },
    polymarket: { YES: 0, NO: 0 }
  },
  venueSlippageRates: {
    kalshi: { YES: 0.005, NO: 0.005 },
    polymarket: { YES: 0.005, NO: 0.005 }
  },
  feeModels: {
    kalshi: { type: "kalshi", rate: 0.07, version: "kalshi-crypto-taker-v1" },
    polymarket: { type: "polymarket", feeRateBps: 0, takerFeeRateBps: 0, orderRole: "taker", version: "polymarket-crypto-taker-v1" }
  },
  feeSource: "config",
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase4-realistic-costs-v1"
};

export class OpportunityCalculator {
  calculate(
    pair: CandidatePair,
    decision: EquivalenceDecision,
    kalshiBook: MarketBook,
    polymarketBook: MarketBook,
    options: Partial<OpportunityCalculatorOptions> = {}
  ): CrossVenueOpportunity[] {
    if (decision.equivalenceClass !== "A") {
      return [];
    }

    const mergedOptions = mergeOptions(options);
    if (!mergedOptions.now) {
      mergedOptions.now = new Date().toISOString();
    }
    if (!this.isUsableBook(kalshiBook, mergedOptions) || !this.isUsableBook(polymarketBook, mergedOptions)) {
      return [];
    }

    const directions = [
      {
        id: "kalshi_yes-polymarket_no",
        longLeg: this.toLeg(kalshiBook, "YES", mergedOptions),
        hedgeLeg: this.toLeg(polymarketBook, "NO", mergedOptions)
      },
      {
        id: "polymarket_yes-kalshi_no",
        longLeg: this.toLeg(polymarketBook, "YES", mergedOptions),
        hedgeLeg: this.toLeg(kalshiBook, "NO", mergedOptions)
      }
    ];

    return directions
      .filter(({ longLeg, hedgeLeg }) => this.isValidLeg(longLeg) && this.isValidLeg(hedgeLeg))
      .map(({ id, longLeg, hedgeLeg }) => this.toOpportunity(pair.id, pair, id, "A", decision, longLeg, hedgeLeg, [kalshiBook, polymarketBook], mergedOptions))
      .filter((opportunity): opportunity is CrossVenueOpportunity => opportunity !== undefined);
  }

  private isUsableBook(book: MarketBook, options: OpportunityCalculatorOptions): boolean {
    if (book.stale) {
      return false;
    }

    const ageMs = bookAgeMs(book, options.now);
    return ageMs !== undefined && ageMs >= 0 && ageMs <= options.maxBookAgeMs;
  }

  private toLeg(book: MarketBook, side: ContractSide, options: OpportunityCalculatorOptions): ContractLeg {
    const askPrice = side === "YES" ? book.yesAsk : book.noAsk;
    return {
      venue: book.venue,
      marketId: book.marketId,
      side,
      askPrice,
      availableUsd: side === "YES" ? book.yesAvailableUsd : book.noAvailableUsd,
      feeRate: feeRateFor(book, side, options),
      slippageRate: rateFor(options.venueSlippageRates, book.venue, side, options.slippageRate),
      feeModelVersion: feeModelFor(options, book.venue)?.version,
      feeModel: feeModelFor(options, book.venue),
      depthLevels: normalizedDepthLevels(book, side)
    };
  }

  private isValidLeg(leg: ContractLeg): boolean {
    return (
      Number.isFinite(leg.askPrice) &&
      leg.askPrice > 0 &&
      leg.askPrice < 1 &&
      Number.isFinite(leg.availableUsd) &&
      leg.availableUsd > 0
    );
  }

  private toOpportunity(
    pairId: string,
    pair: CandidatePair,
    directionId: string,
    equivalenceClass: "A",
    decision: EquivalenceDecision,
    longLeg: ContractLeg,
    hedgeLeg: ContractLeg,
    books: [MarketBook, MarketBook],
    options: OpportunityCalculatorOptions
  ): CrossVenueOpportunity | undefined {
    const combinedCost = round(longLeg.askPrice + hedgeLeg.askPrice);
    const grossEdge = round(1 - combinedCost);
    const estimatedFees = round(feeForLeg(longLeg) + feeForLeg(hedgeLeg));
    const estimatedSlippage = round(slippageForLeg(longLeg) + slippageForLeg(hedgeLeg));
    const maxTradableUsd = roundUsd(Math.min(longLeg.availableUsd, hedgeLeg.availableUsd));
    const notionalEdges = options.targetNotionalsUsd.map((target) => simulateNotionalEdge(target, longLeg, hedgeLeg));
    // Executable size = the largest fully fillable candidate (configured target
    // notionals plus the top-of-book liquidity cap) whose depth-walked net edge
    // clears minNetEdge + profitabilityBuffer. This replaces the former final
    // top-of-book-only profitability filter: deeper configured targets may exceed
    // maxTradableUsd yet still qualify when the full depth ladder can fill them.
    // Drop the direction when no candidate is profitable at an executable size.
    const executableCandidates = [...new Set([...options.targetNotionalsUsd, maxTradableUsd])]
      .filter((target) => Number.isFinite(target) && target > 0)
      .map((target) => simulateNotionalEdge(target, longLeg, hedgeLeg))
      .filter((edge) => edge.fillable && edge.netEdge > options.minNetEdge + options.profitabilityBuffer)
      .sort((left, right) => left.targetNotionalUsd - right.targetNotionalUsd);
    const executableEdge = executableCandidates.at(-1);
    if (!executableEdge) return undefined;
    const executableSizeUsd = executableEdge.targetNotionalUsd;
    const dataStalenessMs = Math.max(...books.map((book) => bookAgeMs(book, options.now) ?? options.maxBookAgeMs + 1));

    // ADR-0002 §3.6: derive the risk structure for this pair from normalized market fields.
    const riskStructure = buildRiskStructure(pair, longLeg, hedgeLeg);

    return {
      id: `${pairId}:${directionId}`,
      pairId,
      longLeg,
      hedgeLeg,
      combinedCost,
      grossEdge,
      estimatedFees,
      estimatedSlippage,
      netEdge: round(grossEdge - estimatedFees - estimatedSlippage),
      theoreticalCombinedCost: combinedCost,
      theoreticalGrossEdge: grossEdge,
      theoreticalNetEdge: round(grossEdge - estimatedFees - estimatedSlippage),
      executableSizeUsd,
      executableCombinedCost: round(1 - executableEdge.grossEdge),
      executableGrossEdge: executableEdge.grossEdge,
      executableNetEdge: executableEdge.netEdge,
      maxTradableUsd,
      notionalEdges,
      equivalenceClass,
      resolutionRisk: resolutionRisk(decision),
      fillRisk: fillRisk(maxTradableUsd, notionalEdges),
      liquidityRisk: liquidityRisk(maxTradableUsd, notionalEdges),
      venueRisk: venueRisk(dataStalenessMs, options.maxBookAgeMs),
      equivalenceRisk: equivalenceRisk(decision),
      dataStalenessMs,
      opportunityAgeMs: opportunityAgeMs(options.previousDetectedAt, options.now),
      detectedAt: options.now,
      firstDetectedAt: options.previousDetectedAt ?? options.now,
      lastVerifiedAt: options.now,
      calculationVersion: options.calculationVersion,
      configVersion: options.configVersion,
      riskStructure
    };
  }
}

// ADR-0002 §3.6: build the classifier input from the pair's normalized markets and the computed legs.
// The venue→market lookup is exhaustive over Venue so the compiler forces an
// update here if a new venue is added (mirrors AssertNoUnhandledDefaultVenue).
function buildRiskStructure(pair: CandidatePair, longLeg: ContractLeg, hedgeLeg: ContractLeg): RiskStructure {
  const legToInput = (leg: ContractLeg) => {
    const market: NormalizedMarket =
      leg.venue === "kalshi" ? pair.kalshiMarket
      : leg.venue === "polymarket" ? pair.polymarketMarket
      : assertNeverVenue(leg.venue);
    return {
      venue: leg.venue,
      marketId: leg.marketId,
      side: leg.side,
      deadline: market.deadline,
      resolutionSource: market.resolutionSource,
      payoffType: market.payoffType
    };
  };

  return classifyRiskStructure({ legA: legToInput(longLeg), legB: legToInput(hedgeLeg) });
}

function assertNeverVenue(venue: never): NormalizedMarket {
  throw new Error(`Unhandled venue ${JSON.stringify(venue)} in buildRiskStructure; add it to the leg→market mapping.`);
}

function mergeOptions(options: Partial<OpportunityCalculatorOptions>): OpportunityCalculatorOptions {
  const targetNotionalsUsd = [...new Set(options.targetNotionalsUsd ?? DEFAULT_OPTIONS.targetNotionalsUsd)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  return {
    ...DEFAULT_OPTIONS,
    ...options,
    venueFeeRates: mergeVenueRates(defaultVenueRates(options.feeRate ?? DEFAULT_OPTIONS.feeRate), options.venueFeeRates),
    venueSlippageRates: mergeVenueRates(defaultVenueRates(options.slippageRate ?? DEFAULT_OPTIONS.slippageRate), options.venueSlippageRates),
    // Phase 4: default to realistic per-venue fee models. A caller can still
    // override with flat rates by passing explicit feeModels (including an
    // empty object to disable models entirely), but absent an override the
    // scanner uses Kalshi/Polymarket probability-weighted fees.
    feeModels: options.feeModels ?? DEFAULT_OPTIONS.feeModels,
    targetNotionalsUsd: targetNotionalsUsd.length > 0 ? targetNotionalsUsd : DEFAULT_OPTIONS.targetNotionalsUsd
  };
}

function defaultVenueRates(rate: number): VenueFeeRates {
  const entries = VENUES.map((venue) => [
    venue,
    KNOWN_VENUES.includes(venue as KnownVenue) ? { YES: rate, NO: rate } : {}
  ]) as [Venue, SideRates][];
  return Object.fromEntries(entries) as VenueFeeRates;
}

function mergeVenueRates(defaults: VenueFeeRates, overrides: VenueFeeRates | undefined): VenueFeeRates {
  return Object.fromEntries(
    VENUES.map((venue) => [venue, { ...defaults[venue], ...overrides?.[venue] }])
  ) as VenueFeeRates;
}

function rateFor(rates: VenueFeeRates, venue: Venue, side: ContractSide, fallback: number): number {
  if (!VENUES.includes(venue)) throw new Error(`Unknown venue ${venue}; no rate configured`);
  return rates[venue]?.[side] ?? fallback;
}

function feeRateFor(book: MarketBook, side: ContractSide, options: OpportunityCalculatorOptions): number {
  const configured = rateFor(options.venueFeeRates, book.venue, side, options.feeRate);
  if (options.feeSource !== "market-payload") return configured;

  const fromPayload = resolvePolymarketFeeRate(book, side);
  return fromPayload ?? configured;
}

function feeModelFor(options: OpportunityCalculatorOptions, venue: Venue): FeeModel | undefined {
  const model = options.feeModels?.[venue];
  if (!model) return undefined;
  if (model.type === "kalshi" && venue !== "kalshi") throw new Error(`Kalshi fee model applied to ${venue}`);
  if (model.type === "polymarket" && venue !== "polymarket") throw new Error(`Polymarket fee model applied to ${venue}`);
  return model;
}

function normalizedDepthLevels(book: MarketBook, side: ContractSide): PriceLevel[] {
  const levels = side === "YES" ? book.yesDepth : book.noDepth;
  const fallbackAsk = side === "YES" ? book.yesAsk : book.noAsk;
  const fallbackAvailableUsd = side === "YES" ? book.yesAvailableUsd : book.noAvailableUsd;
  const normalized = (levels ?? [])
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);

  if (normalized.length > 0) return normalized;
  return Number.isFinite(fallbackAsk) && fallbackAsk > 0 && fallbackAsk < 1 && fallbackAvailableUsd > 0
    ? [{ price: fallbackAsk, size: fallbackAvailableUsd / fallbackAsk }]
    : [];
}

function simulateNotionalEdge(targetNotionalUsd: number, longLeg: ContractLeg, hedgeLeg: ContractLeg): NotionalEdge {
  const longFill = simulateLegFill(longLeg, targetNotionalUsd);
  const hedgeFill = simulateLegFill(hedgeLeg, targetNotionalUsd);
  const fillable = longFill.fillable && hedgeFill.fillable;
  const combinedCost = longFill.averagePrice + hedgeFill.averagePrice;
  const grossEdge = round(1 - combinedCost);
  const estimatedFees = round(feeForPrice(longFill.averagePrice, longLeg.feeModel, longLeg.feeRate ?? 0) + feeForPrice(hedgeFill.averagePrice, hedgeLeg.feeModel, hedgeLeg.feeRate ?? 0));
  const estimatedSlippage = round(longFill.averagePrice * (longLeg.slippageRate ?? 0) + hedgeFill.averagePrice * (hedgeLeg.slippageRate ?? 0));

  return {
    targetNotionalUsd,
    grossEdge,
    estimatedFees,
    estimatedSlippage,
    netEdge: round(grossEdge - estimatedFees - estimatedSlippage),
    fillable
  };
}

function simulateLegFill(leg: ContractLeg, targetNotionalUsd: number): { averagePrice: number; fillable: boolean } {
  const levels = leg.depthLevels?.length
    ? leg.depthLevels
    : isFinitePrice(leg.askPrice) && Number.isFinite(leg.availableUsd) && leg.availableUsd > 0
      ? [{ price: leg.askPrice, size: leg.availableUsd / leg.askPrice }]
      : [];
  if (levels.length === 0) return { averagePrice: 0, fillable: false };

  let remainingUsd = targetNotionalUsd;
  let totalCost = 0;
  let totalContracts = 0;

  for (const level of levels) {
    if (remainingUsd <= 0) break;
    if (!isFinitePrice(level.price) || !Number.isFinite(level.size) || level.size <= 0) continue;
    const levelUsd = level.price * level.size;
    const spendUsd = Math.min(remainingUsd, levelUsd);
    totalCost += spendUsd;
    totalContracts += spendUsd / level.price;
    remainingUsd -= spendUsd;
  }

  if (totalContracts <= 0) return { averagePrice: isFinitePrice(leg.askPrice) ? leg.askPrice : 0, fillable: false };
  return { averagePrice: totalCost / totalContracts, fillable: remainingUsd <= 0.000001 };
}

function isFinitePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function feeForLeg(leg: ContractLeg): number {
  return feeForPrice(leg.askPrice, leg.feeModel, leg.feeRate ?? 0);
}

function feeForPrice(price: number, feeModel: FeeModel | undefined, fallbackRate: number): number {
  if (!feeModel || feeModel.type === "flat") {
    const rate = typeof feeModel?.rate === "number" ? feeModel.rate : fallbackRate;
    return price * rate;
  }

  if (feeModel.type === "kalshi") {
    const rate = typeof feeModel.rate === "number" ? feeModel.rate : fallbackRate;
    return ceil4(rate * price * (1 - price));
  }

  if (feeModel.type === "polymarket") {
    const role = feeModel.orderRole === "maker" ? "maker" : "taker";
    const roleBps = role === "maker" ? feeModel.makerFeeRateBps : feeModel.takerFeeRateBps;
    const feeRateBps = typeof roleBps === "number" ? roleBps : typeof feeModel.feeRateBps === "number" ? feeModel.feeRateBps : fallbackRate * 10_000;
    const operatorFeeRateBps = typeof feeModel.operatorFeeRateBps === "number" ? feeModel.operatorFeeRateBps : 0;
    return price * ((feeRateBps + operatorFeeRateBps) / 10_000);
  }

  return assertNever(feeModel);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled fee model: ${JSON.stringify(value)}`);
}

function slippageForLeg(leg: ContractLeg): number {
  return leg.askPrice * (leg.slippageRate ?? 0);
}

function bookAgeMs(book: MarketBook, nowIso: string): number | undefined {
  const capturedAt = new Date(book.capturedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now)) return undefined;
  return now - capturedAt;
}

function opportunityAgeMs(previousDetectedAt: string | undefined, nowIso: string): number {
  if (!previousDetectedAt) return 0;
  const previous = new Date(previousDetectedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(previous) || !Number.isFinite(now)) return 0;
  return Math.max(0, now - previous);
}

function resolutionRisk(decision: EquivalenceDecision): RiskLevel {
  if (decision.reasons.some((reason) => reason.includes("resolution_source") || reason.includes("payoff_type"))) return "medium";
  return "low";
}

function equivalenceRisk(decision: EquivalenceDecision): RiskLevel {
  if (decision.reasons.some((reason) => reason.includes("material") || reason.includes("mismatch"))) return "high";
  if (decision.reasons.length > 0) return "medium";
  return "low";
}

function fillRisk(maxTradableUsd: number, notionalEdges: NotionalEdge[]): RiskLevel {
  const fillableCount = notionalEdges.filter((edge) => edge.fillable).length;
  if (maxTradableUsd < 5 || fillableCount === 0) return "high";
  if (maxTradableUsd < 25 || fillableCount < Math.min(2, notionalEdges.length)) return "medium";
  return "low";
}

function liquidityRisk(maxTradableUsd: number, notionalEdges: NotionalEdge[]): RiskLevel {
  const largestFillable = notionalEdges.filter((edge) => edge.fillable).at(-1)?.targetNotionalUsd ?? 0;
  if (maxTradableUsd < 10 || largestFillable < 5) return "high";
  if (maxTradableUsd < 100 || largestFillable < 25) return "medium";
  return "low";
}

function venueRisk(dataStalenessMs: number, maxBookAgeMs: number): RiskLevel {
  if (dataStalenessMs > maxBookAgeMs) return "high";
  if (dataStalenessMs > maxBookAgeMs / 2) return "medium";
  return "low";
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function ceil4(value: number): number {
  return Math.ceil(value * 10000) / 10000;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
