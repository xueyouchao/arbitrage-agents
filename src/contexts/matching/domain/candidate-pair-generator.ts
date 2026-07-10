import { CandidatePair } from "./candidate-pair";
import { bothCryptoPriceLevels } from "./crypto-market";
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
    return thresholdsMatch(left.threshold, right.threshold, left, right) && deadlinesMatch(left.deadline, right.deadline, left, right);
  }
}

function bucketKey(market: NormalizedMarket): string {
  return [market.topic, market.asset ?? "", market.eventType, market.payoffType].join("|");
}

function thresholdsMatch(left?: number, right?: number, leftMarket?: NormalizedMarket, rightMarket?: NormalizedMarket): boolean {
  // Non-numeric markets (sports winner, politics election, current-event
  // yes/no) have no threshold. Treat undefined-on-both as compatible so they
  // can still produce candidate pairs.
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }

  if (Math.abs(left - right) < 0.000001) {
    return true;
  }

  // Crypto price-level markets use slightly different strike ladders across
  // venues (e.g. Polymarket "$52,000" vs Kalshi "$51,999.99"). Treat strikes
  // within $1 as compatible candidates; the equivalence policy records the
  // residual difference as an advisory reason.
  if (leftMarket && rightMarket && bothCryptoPriceLevels(leftMarket, rightMarket) && Math.abs(left - right) <= 1) {
    return true;
  }

  return false;
}

function deadlinesMatch(left?: string, right?: string, leftMarket?: NormalizedMarket, rightMarket?: NormalizedMarket): boolean {
  if (!left || !right) {
    return false;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return false;
  }

  if (Math.abs(leftTime - rightTime) <= DEFAULT_DEADLINE_TOLERANCE_MS) {
    return true;
  }

  // Crypto price-level markets often settle at different times on the same
  // calendar day across venues (e.g. Kalshi at 4pm EDT / 20:00 UTC, Polymarket
  // at 16:00 UTC). Treat same-day expiries as compatible candidates while the
  // equivalence policy still records the time-of-day difference as an advisory
  // reason.
  if (leftMarket && rightMarket && bothCryptoPriceLevels(leftMarket, rightMarket)) {
    return sameUtcDay(leftTime, rightTime);
  }

  return false;
}

function sameUtcDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

