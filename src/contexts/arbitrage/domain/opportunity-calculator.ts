import { CandidatePair, EquivalenceDecision } from "../../matching/domain/candidate-pair";
import { ContractLeg, CrossVenueOpportunity, MarketBook } from "./opportunity";

export interface OpportunityCalculatorOptions {
  feeRate: number;
  slippageRate: number;
  now: string;
  maxBookAgeMs: number;
}

const DEFAULT_OPTIONS: OpportunityCalculatorOptions = {
  feeRate: 0.01,
  slippageRate: 0.005,
  now: "",
  maxBookAgeMs: 60_000
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

    const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
    if (!mergedOptions.now) {
      mergedOptions.now = new Date().toISOString();
    }
    if (!this.isUsableBook(kalshiBook, mergedOptions) || !this.isUsableBook(polymarketBook, mergedOptions)) {
      return [];
    }

    const directions = [
      {
        id: "kalshi_yes-polymarket_no",
        longLeg: this.toLeg(kalshiBook, "YES"),
        hedgeLeg: this.toLeg(polymarketBook, "NO")
      },
      {
        id: "polymarket_yes-kalshi_no",
        longLeg: this.toLeg(polymarketBook, "YES"),
        hedgeLeg: this.toLeg(kalshiBook, "NO")
      }
    ];

    return directions
      .filter(({ longLeg, hedgeLeg }) => this.isValidLeg(longLeg) && this.isValidLeg(hedgeLeg))
      .map(({ id, longLeg, hedgeLeg }) => this.toOpportunity(pair.id, id, "A", longLeg, hedgeLeg, mergedOptions))
      .filter((opportunity) => opportunity.netEdge > 0);
  }

  private isUsableBook(book: MarketBook, options: OpportunityCalculatorOptions): boolean {
    if (book.stale) {
      return false;
    }

    const capturedAt = new Date(book.capturedAt).getTime();
    const now = new Date(options.now).getTime();
    if (!Number.isFinite(capturedAt) || !Number.isFinite(now)) {
      return false;
    }

    const ageMs = now - capturedAt;
    return ageMs >= 0 && ageMs <= options.maxBookAgeMs;
  }

  private toLeg(book: MarketBook, side: "YES" | "NO"): ContractLeg {
    return {
      venue: book.venue,
      marketId: book.marketId,
      side,
      askPrice: side === "YES" ? book.yesAsk : book.noAsk,
      availableUsd: side === "YES" ? book.yesAvailableUsd : book.noAvailableUsd
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
    longLeg: ContractLeg,
    hedgeLeg: ContractLeg,
    options: OpportunityCalculatorOptions
  ): CrossVenueOpportunity {
    const combinedCost = round(longLeg.askPrice + hedgeLeg.askPrice);
    const grossEdge = round(1 - combinedCost);
    const estimatedFees = round(combinedCost * options.feeRate);
    const estimatedSlippage = round(combinedCost * options.slippageRate);
    const maxTradableUsd = Math.min(longLeg.availableUsd, hedgeLeg.availableUsd);

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
      equivalenceClass,
      resolutionRisk: "low",
      fillRisk: maxTradableUsd >= 25 ? "low" : maxTradableUsd >= 5 ? "medium" : "high",
      detectedAt: options.now,
      lastVerifiedAt: options.now
    };
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
