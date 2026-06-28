/**
 * Emergency World Cup 2026 pair matcher.
 *
 * Takes World-Cup-normalised markets and produces cross-venue candidate pairs
 * by matching on the canonical team code + market type. This bypasses the
 * generic `CandidatePairGenerator`, which matches on raw normalised asset
 * strings that are not stable across venues for World Cup markets.
 *
 * The output is a `WorldCupCandidatePair` that carries both the World Cup
 * normalised payloads AND a bridged `CandidatePair` conforming to the
 * generic type, so the existing `OpportunityCalculator` and
 * `PaperTradeSimulator` can be reused unchanged.
 *
 * @emergency This module is a temporary replacement for the generic pair
 * generator until topic normalisation can produce stable team codes. When
 * the generic pipeline produces stable keys for all World Cup markets,
 * delete this file and use the generic `CandidatePairGenerator`.
 */

import { CandidatePair } from "../../matching/domain/candidate-pair";
import {
  EventType,
  NormalizedMarket,
  PayoffType,
  Topic,
} from "../../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import {
  classifyWorldCupMarket,
  WorldCupMarketType,
  WorldCupNormalizedMarket,
} from "./worldcup-normalizer";

export interface WorldCupCandidatePair {
  id: string;
  kalshiMarket: WorldCupNormalizedMarket;
  polymarketMarket: WorldCupNormalizedMarket;
  /** Bridged generic pair so the existing OpportunityCalculator works. */
  genericPair: CandidatePair;
  /** Human-readable reasons for logging. */
  reasons: string[];
}

/**
 * Build cross-venue World Cup candidate pairs from raw venue snapshots.
 *
 * The algorithm:
 *   1. Classify every snapshot as a World Cup market (others are ignored).
 *   2. Only keep markets where the team code was successfully resolved —
 *      unresolved markets cannot be matched cross-venue.
 *   3. Bucket Polymarket markets by (marketType, teamCode, opponentCode,
 *      threshold, groupName).
 *   4. For each Kalshi market, look up the matching bucket and produce a
 *      pair for every hit.
 */
export function buildWorldCupPairs(snapshots: VenueMarketSnapshot[]): WorldCupCandidatePair[] {
  const wcMarkets = classifyAndFilter(snapshots);
  return matchPairs(wcMarkets);
}

function classifyAndFilter(snapshots: VenueMarketSnapshot[]): WorldCupNormalizedMarket[] {
  return snapshots
    .map(classifyWorldCupMarket)
    .filter((wc): wc is WorldCupNormalizedMarket => {
      if (!wc || !wc.teamResolved) return false;
      // Match-type markets require opponent to be resolved too —
      // otherwise "Ecuador vs Curaçao" could pair with "CIV vs Ecuador".
      if (wc.marketType === WorldCupMarketType.Match && !wc.opponentCode) return false;
      return true;
    });
}

function matchPairs(markets: WorldCupNormalizedMarket[]): WorldCupCandidatePair[] {
  // Bucket Polymarket markets by match key.
  const polyBuckets = new Map<string, WorldCupNormalizedMarket[]>();
  for (const market of markets) {
    if (market.venue !== "polymarket") continue;
    const key = pairBucketKey(market);
    const bucket = polyBuckets.get(key) ?? [];
    bucket.push(market);
    polyBuckets.set(key, bucket);
  }

  // Match Kalshi markets against the buckets.
  const pairs: WorldCupCandidatePair[] = [];
  for (const kalshiMarket of markets) {
    if (kalshiMarket.venue !== "kalshi") continue;
    const bucket = polyBuckets.get(pairBucketKey(kalshiMarket));
    if (!bucket) continue;
    for (const polyMarket of bucket) {
      const genericPair = bridgeToGenericPair(kalshiMarket, polyMarket);
      pairs.push({
        id: `${kalshiMarket.id}:${polyMarket.id}`,
        kalshiMarket,
        polymarketMarket: polyMarket,
        genericPair,
        reasons: [
          "cross_venue",
          `wc_team_${kalshiMarket.teamCode}`,
          `wc_type_${kalshiMarket.marketType}`,
          kalshiMarket.opponentCode ? `wc_opponent_${kalshiMarket.opponentCode}` : "wc_opponent_none",
          `wc_resolved_${kalshiMarket.teamResolved}`,
        ],
      });
    }
  }

  return pairs;
}

/**
 * Bucketing key: groups markets that describe the same underlying event.
 * For winner markets the key is "winner|{teamCode}|undefined|undefined".
 * For match markets it includes the opponent code so Brazil-vs-Argentina
 * doesn't match Brazil-vs-Germany.
 */
function pairBucketKey(market: WorldCupNormalizedMarket): string {
  return [
    market.marketType,
    market.teamCode ?? "_",
    market.opponentCode ?? "_",
    market.threshold?.toString() ?? "_",
    market.groupName ?? "_",
  ].join("|");
}

/**
 * Bridge a World Cup candidate pair to the generic CandidatePair type that
 * the OpportunityCalculator expects. This maps the World Cup normalization
 * into the generic NormalizedMarket schema.
 */
function bridgeToGenericPair(
  kalshi: WorldCupNormalizedMarket,
  polymarket: WorldCupNormalizedMarket
): CandidatePair {
  return {
    id: `${kalshi.id}:${polymarket.id}`,
    kalshiMarket: bridgeToNormalized(kalshi),
    polymarketMarket: bridgeToNormalized(polymarket),
    reasons: [
      "cross_venue",
      "wc_team_match",
      `wc_${kalshi.teamCode}`,
    ],
  };
}

function bridgeToNormalized(wc: WorldCupNormalizedMarket): NormalizedMarket {
  const topic: Topic = "sports";
  const eventType = mapEventType(wc.marketType);
  const payoffType: PayoffType = "at_time";
  // Use the team code as the "asset" so the calculator can key it.
  const asset = wc.teamCode ?? wc.subject;

  return {
    id: wc.id,
    venue: wc.venue as NormalizedMarket["venue"],
    venueMarketId: wc.venueMarketId,
    title: wc.originalTitle,
    rawResolutionText: "",
    topic,
    eventType,
    asset,
    threshold: wc.threshold,
    deadline: WORLD_CUP_2026_DEADLINE,
    timezone: "UTC",
    resolutionSource: "official fifa result",
    payoffType,
    ambiguityFlags: [],
    confidence: 0.95,
  };
}

function mapEventType(marketType: WorldCupMarketType): EventType {
  return marketType === WorldCupMarketType.Winner ? "winner" : "yes_no";
}

// 2026 FIFA World Cup final is scheduled for July 19, 2026.
const WORLD_CUP_2026_DEADLINE = new Date(Date.UTC(2026, 6, 19, 0, 0, 0)).toISOString();
