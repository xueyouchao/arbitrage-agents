import { CandidatePair } from "./candidate-pair";
import { isCryptoPriceLevel } from "./crypto-market";
import {
  CRYPTO_THRESHOLD_TOLERANCE,
  deadlinesCompatible,
  DeadlineToleranceConfig,
  DEFAULT_DEADLINE_TOLERANCE_CONFIG,
  EXACT_THRESHOLD_TOLERANCE,
  thresholdsCompatible,
} from "./market-compatibility";
import { NormalizedMarket } from "./normalized-market";

// Strike-band size used to pre-group threshold-bearing markets in the
// polymarket bucket map. It is intentionally aligned with the fuzzy
// threshold tolerance in `thresholdsMatch`: crypto price-level markets
// are matched when their strikes differ by at most $1, so a $1 band keeps
// any two within-tolerance strikes in adjacent bands. Markets are emitted
// into BOTH their floor and floor+1 band (see `bucketKeysFor`) so a pair
// straddling a band boundary still collides. This bounds the candidate
// cross-product from O(strikesPerDay^2) toward O(strikesPerDay) without
// changing which pairs `isCandidate` admits.
//
// For exact-threshold topics (non-crypto numeric thresholds, e.g. sports
// totals), `thresholdsMatch` requires diff < 1e-6; those use a 1e-6 band and
// a single bucket so only identical-strike markets collide.
const CRYPTO_STRIKE_BAND = CRYPTO_THRESHOLD_TOLERANCE;
const EXACT_STRIKE_BAND = EXACT_THRESHOLD_TOLERANCE;

export interface CandidatePairGeneratorOptions {
  deadlineTolerance?: DeadlineToleranceConfig;
}

export class CandidatePairGenerator {
  private readonly deadlineTolerance: DeadlineToleranceConfig;

  constructor(options?: CandidatePairGeneratorOptions) {
    this.deadlineTolerance = options?.deadlineTolerance ?? DEFAULT_DEADLINE_TOLERANCE_CONFIG;
  }

  generate(markets: NormalizedMarket[]): CandidatePair[] {
    const polymarketBuckets = this.bucketPolymarketMarkets(markets);
    const seen = new Set<string>();

    return markets
      .filter((market) => market.venue === "kalshi")
      .flatMap((kalshiMarket) => {
        const candidates = bucketKeysFor(kalshiMarket).flatMap((key) => polymarketBuckets.get(key) ?? []);
        return candidates
          .filter((polymarketMarket) => this.isCandidate(kalshiMarket, polymarketMarket))
          .map((polymarketMarket) => {
            const id = `${kalshiMarket.id}:${polymarketMarket.id}`;
            // De-duplicate when a kalshi market and a polymarket market land in
            // more than one shared band (band expansion can surface the same
            // candidate twice). Preserves a stable, first-seen ordering.
            if (seen.has(id)) return undefined;
            seen.add(id);
            return {
              id,
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
            };
          })
          .filter((pair): pair is CandidatePair => pair !== undefined);
      });
  }

  private bucketPolymarketMarkets(markets: NormalizedMarket[]): Map<string, NormalizedMarket[]> {
    const buckets = new Map<string, NormalizedMarket[]>();
    for (const market of markets) {
      if (market.venue !== "polymarket") {
        continue;
      }

      for (const key of bucketKeysFor(market)) {
        const bucket = buckets.get(key) ?? [];
        bucket.push(market);
        buckets.set(key, bucket);
      }
    }

    return buckets;
  }

  private isCandidate(left: NormalizedMarket, right: NormalizedMarket): boolean {
    return (
      thresholdsCompatible(left.threshold, right.threshold, left, right).compatible &&
      deadlinesCompatible(left.deadline, right.deadline, left, right, this.deadlineTolerance).compatible
    );
  }
}

/**
 * Returns the set of bucket keys a market belongs to.
 *
 * - Non-threshold markets (sports winner, politics election, current-event
 *   yes/no) collapse to a single `topic|asset|eventType|payoffType` bucket,
 *   matching the historical behavior.
 * - Exact-threshold markets (non-crypto numeric thresholds) use a 1e-6 band
 *   and a single bucket so only identical-strike markets collide.
 * - Crypto price-level markets use a $1 band and are emitted into both their
 *   floor and floor+1 band so a within-$1 pair straddling a band boundary
 *   still collides. Band expansion is bounded to 2 keys per market.
 */
function bucketKeysFor(market: NormalizedMarket): string[] {
  const base = [market.topic, market.asset ?? "", market.eventType, market.payoffType].join("|");
  if (market.threshold === undefined) {
    return [base];
  }

  const crypto = isCryptoPriceLevel(market);
  const band = crypto ? CRYPTO_STRIKE_BAND : EXACT_STRIKE_BAND;
  const floor = Math.floor(market.threshold / band);
  if (!crypto) {
    return [`${base}|${floor}`];
  }

  // Crypto: emit floor and floor+1 so a pair straddling a $1 boundary collides.
  return [`${base}|${floor}`, `${base}|${floor + 1}`];
}

