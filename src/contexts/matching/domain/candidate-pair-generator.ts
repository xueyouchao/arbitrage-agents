import { CandidatePair } from "./candidate-pair";
import { NormalizedMarket } from "./normalized-market";

const DEFAULT_DEADLINE_TOLERANCE_MS = 60 * 1000;

export class CandidatePairGenerator {
  generate(markets: NormalizedMarket[]): CandidatePair[] {
    const polymarketBuckets = this.bucketPolymarketMarkets(markets);

    return markets
      .filter((market) => market.venue === "kalshi")
      .flatMap((kalshiMarket) =>
        (polymarketBuckets.get(bucketKey(kalshiMarket)) ?? [])
          .filter((polymarketMarket) => this.isCandidate(kalshiMarket, polymarketMarket))
          .map((polymarketMarket) => ({
            id: `${kalshiMarket.id}:${polymarketMarket.id}`,
            kalshiMarket,
            polymarketMarket,
            reasons: [
              "cross_venue",
              "same_topic",
              "same_asset",
              "same_event_type",
              "same_payoff_type",
              "compatible_threshold",
              "compatible_deadline"
            ]
          }))
      );
  }

  private bucketPolymarketMarkets(markets: NormalizedMarket[]): Map<string, NormalizedMarket[]> {
    const buckets = new Map<string, NormalizedMarket[]>();
    for (const market of markets) {
      if (market.venue !== "polymarket") {
        continue;
      }

      const key = bucketKey(market);
      const bucket = buckets.get(key) ?? [];
      bucket.push(market);
      buckets.set(key, bucket);
    }

    return buckets;
  }

  private isCandidate(left: NormalizedMarket, right: NormalizedMarket): boolean {
    return thresholdsMatch(left.threshold, right.threshold) && deadlinesMatch(left.deadline, right.deadline);
  }
}

function bucketKey(market: NormalizedMarket): string {
  return [market.topic, market.asset ?? "", market.eventType, market.payoffType].join("|");
}

function thresholdsMatch(left?: number, right?: number): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }

  return Math.abs(left - right) < 0.000001;
}

function deadlinesMatch(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return false;
  }

  return Math.abs(leftTime - rightTime) <= DEFAULT_DEADLINE_TOLERANCE_MS;
}
