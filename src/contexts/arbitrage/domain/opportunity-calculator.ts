import { CandidatePair, EquivalenceDecision } from "../../matching/domain/candidate-pair";
import { Venue } from "../../matching/domain/normalized-market";
import { ContractLeg, ContractSide, CrossVenueOpportunity, MarketBook, NotionalEdge, PriceLevel, RiskLevel } from "./opportunity";

export interface OpportunityCalculatorOptions {
  feeRate: number;
  slippageRate: number;
  now: string;
  maxBookAgeMs: number;
  minNetEdge: number;
  targetNotionalsUsd: number[];
  venueFeeRates: VenueFeeRates;
  venueSlippageRates: VenueSlippageRates;
  calculationVersion: string;
  configVersion: string;
}

type SideRates = Partial<Record<ContractSide, number>>;
type VenueFeeRates = Partial<Record<Venue, SideRates>>;
type VenueSlippageRates = Partial<Record<Venue, SideRates>>;

const DEFAULT_OPTIONS: OpportunityCalculatorOptions = {
  feeRate: 0.01,
  slippageRate: 0.005,
  now: "",
  maxBookAgeMs: 60_000,
  minNetEdge: 0,
  targetNotionalsUsd: [5, 25, 100],
  venueFeeRates: {
    kalshi: { YES: 0.01, NO: 0.01 },
    polymarket: { YES: 0.01, NO: 0.01 }
  },
  venueSlippageRates: {
    kalshi: { YES: 0.005, NO: 0.005 },
    polymarket: { YES: 0.005, NO: 0.005 }
  },
  calculationVersion: "opportunity-calculator-v2",
  configVersion: "phase3-conservative-v1"
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
      .map(({ id, longLeg, hedgeLeg }) => this.toOpportunity(pair.id, id, "A", decision, longLeg, hedgeLeg, [kalshiBook, polymarketBook], mergedOptions))
      .filter((opportunity) => opportunity.netEdge > mergedOptions.minNetEdge);
  }

  private isUsableBook(book: MarketBook, options: OpportunityCalculatorOptions): boolean {
    if (book.stale) {
      return false;
    }

    const ageMs = bookAgeMs(book, options.now);
    return ageMs !== undefined && ageMs >= 0 && ageMs <= options.maxBookAgeMs;
  }

  private toLeg(book: MarketBook, side: ContractSide, options: OpportunityCalculatorOptions): ContractLeg {
    return {
      venue: book.venue,
      marketId: book.marketId,
      side,
      askPrice: side === "YES" ? book.yesAsk : book.noAsk,
      availableUsd: side === "YES" ? book.yesAvailableUsd : book.noAvailableUsd,
      feeRate: rateFor(options.venueFeeRates, book.venue, side, options.feeRate),
      slippageRate: rateFor(options.venueSlippageRates, book.venue, side, options.slippageRate),
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
    directionId: string,
    equivalenceClass: "A",
    decision: EquivalenceDecision,
    longLeg: ContractLeg,
    hedgeLeg: ContractLeg,
    books: [MarketBook, MarketBook],
    options: OpportunityCalculatorOptions
  ): CrossVenueOpportunity {
    const combinedCost = round(longLeg.askPrice + hedgeLeg.askPrice);
    const grossEdge = round(1 - combinedCost);
    const estimatedFees = round(feeForLeg(longLeg) + feeForLeg(hedgeLeg));
    const estimatedSlippage = round(slippageForLeg(longLeg) + slippageForLeg(hedgeLeg));
    const maxTradableUsd = roundUsd(Math.min(longLeg.availableUsd, hedgeLeg.availableUsd));
    const notionalEdges = options.targetNotionalsUsd.map((target) => simulateNotionalEdge(target, longLeg, hedgeLeg));
    const dataStalenessMs = Math.max(...books.map((book) => bookAgeMs(book, options.now) ?? options.maxBookAgeMs + 1));

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
      maxTradableUsd,
      notionalEdges,
      equivalenceClass,
      resolutionRisk: resolutionRisk(decision),
      fillRisk: fillRisk(maxTradableUsd, notionalEdges),
      liquidityRisk: liquidityRisk(maxTradableUsd, notionalEdges),
      venueRisk: venueRisk(dataStalenessMs, options.maxBookAgeMs),
      equivalenceRisk: equivalenceRisk(decision),
      dataStalenessMs,
      opportunityAgeMs: 0,
      detectedAt: options.now,
      lastVerifiedAt: options.now,
      calculationVersion: options.calculationVersion,
      configVersion: options.configVersion
    };
  }
}

function mergeOptions(options: Partial<OpportunityCalculatorOptions>): OpportunityCalculatorOptions {
  const targetNotionalsUsd = [...new Set(options.targetNotionalsUsd ?? DEFAULT_OPTIONS.targetNotionalsUsd)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  return {
    ...DEFAULT_OPTIONS,
    ...options,
    venueFeeRates: mergeVenueRates(DEFAULT_OPTIONS.venueFeeRates, options.venueFeeRates),
    venueSlippageRates: mergeVenueRates(DEFAULT_OPTIONS.venueSlippageRates, options.venueSlippageRates),
    targetNotionalsUsd: targetNotionalsUsd.length > 0 ? targetNotionalsUsd : DEFAULT_OPTIONS.targetNotionalsUsd
  };
}

function mergeVenueRates(defaults: VenueFeeRates, overrides: VenueFeeRates | undefined): VenueFeeRates {
  return {
    kalshi: { ...defaults.kalshi, ...overrides?.kalshi },
    polymarket: { ...defaults.polymarket, ...overrides?.polymarket }
  };
}

function rateFor(rates: VenueFeeRates, venue: Venue, side: ContractSide, fallback: number): number {
  return rates[venue]?.[side] ?? fallback;
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
  const estimatedFees = round(longFill.averagePrice * (longLeg.feeRate ?? 0) + hedgeFill.averagePrice * (hedgeLeg.feeRate ?? 0));
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
  const levels = leg.depthLevels?.length ? leg.depthLevels : [{ price: leg.askPrice, size: leg.availableUsd / leg.askPrice }];
  let remainingUsd = targetNotionalUsd;
  let totalCost = 0;
  let totalContracts = 0;

  for (const level of levels) {
    if (remainingUsd <= 0) break;
    const levelUsd = level.price * level.size;
    const spendUsd = Math.min(remainingUsd, levelUsd);
    totalCost += spendUsd;
    totalContracts += spendUsd / level.price;
    remainingUsd -= spendUsd;
  }

  if (totalContracts <= 0) return { averagePrice: leg.askPrice, fillable: false };
  return { averagePrice: totalCost / totalContracts, fillable: remainingUsd <= 0.000001 };
}

function feeForLeg(leg: ContractLeg): number {
  return leg.askPrice * (leg.feeRate ?? 0);
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

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
