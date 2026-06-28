/**
 * Emergency World Cup 2026 market normaliser.
 *
 * Operates on raw venue-market snapshots and produces a World-Cup-aware
 * structure that folds in the team-alias resolution from `worldcup-teams`.
 *
 * Markets that do not reference the 2026 FIFA World Cup are ignored — the
 * pipeline's `classifyWorldCupMarket` function returns `undefined` for those,
 * and the caller falls through to the generic normalizer.
 *
 * @emergency Standalone emergency module. When the generic topic
 * normalisation pipeline is extended with stable team-key resolution across
 * venues, this module can be deleted and the World Cup markets can fold
 * into the generic CandidatePairGenerator path.
 */

import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { resolveWorldCupTeam, WORLDCUP_TEAM_CODES } from "./worldcup-teams";

export enum WorldCupMarketType {
  /** Team will win the 2026 World Cup. */
  Winner = "winner",
  /** Match outcome: team A beats team B. */
  Match = "match",
  /** Team will advance from group stage / knockout round. */
  Advance = "advance",
  /** Player will be top scorer. */
  TopScorer = "top_scorer",
}

/** A World Cup market normalised for cross-venue matching. */
export interface WorldCupNormalizedMarket {
  /** Venue-prefixed stable id, e.g. "kalshi:WC2026-WINNER-BRA" */
  id: string;
  venue: string;
  venueMarketId: string;
  /** Original title from the venue — kept for display and debugging. */
  originalTitle: string;
  marketType: WorldCupMarketType;
  /** Canonical 3-letter team code, e.g. "bra", "arg", "usa". */
  teamCode?: string;
  /** Canonical opponent team code for match markets. */
  opponentCode?: string;
  /** Human-readable subject, e.g. "BRA", "BRA vs ARG". */
  subject: string;
  /** Tournament year — always "2026" for this module. */
  tournamentYear: "2026";
  /** Whether the team was resolved to a known alias. */
  teamResolved: boolean;
  /** For over/under-goals markets: the numeric threshold. */
  threshold?: number;
  /** For advance markets: the group letter "A"–"H". */
  groupName?: string;
}

/**
 * Returns `true` if the text clearly references the 2026 FIFA World Cup.
 */
export function isWorldCup2026(text: string): boolean {
  const lower = text.toLowerCase();
  return /2026\s*fifa\s*world\s*cup/.test(lower)
    || /world\s*cup\s*2026/.test(lower)
    || /fifa\s*world\s*cup\s*2026/.test(lower)
    || /\bwc2026\b/.test(lower);
}

/**
 * Classify a raw venue-market snapshot into a World Cup normalized market.
 * Returns `undefined` if the market is not recognisably a 2026 FIFA World Cup
 * market.
 */
/**
 * Kalshi ticker prefix for 2026 FIFA World Cup markets.
 * Individual match/advance/winner markets use KXWC* tickers but their
 * titles don't mention "World Cup" explicitly (e.g. "Brazil vs Japan: To Advance").
 * We also check the venue market ID for this prefix.
 */
const KALSHI_WORLD_CUP_PREFIX = "KXWC";

export function classifyWorldCupMarket(
  snapshot: VenueMarketSnapshot
): WorldCupNormalizedMarket | undefined {
  const text = `${snapshot.title}\n${snapshot.rawResolutionText}`.toLowerCase();
  const venueId = snapshot.venueMarketId;

  if (!isWorldCup2026(text) && !venueId.startsWith(KALSHI_WORLD_CUP_PREFIX)) return undefined;

  const marketType = classifyMarketType(text);
  const teamCode = extractTeamCode(text);
  const opponentCode = extractOpponent(text, teamCode);
  const threshold = extractThreshold(text);
  const groupName = extractGroupName(text);
  const subject = buildSubject(teamCode, opponentCode);

  return {
    id: `${snapshot.venue}:${snapshot.venueMarketId}`,
    venue: snapshot.venue,
    venueMarketId: snapshot.venueMarketId,
    originalTitle: snapshot.title,
    marketType,
    teamCode,
    opponentCode,
    subject,
    tournamentYear: "2026",
    teamResolved: teamCode !== undefined,
    threshold,
    groupName,
  };
}

function classifyMarketType(text: string): WorldCupMarketType {
  if (/\b(?:beat|beats|defeat|defeats|win\s+(?:against|over))\b/.test(text)
    || /\bvs\.?\b/.test(text)
    || /\bversus\b/.test(text)) {
    return WorldCupMarketType.Match;
  }
  if (/\b(?:advance|qualification|group\s+stage|progress)\b/.test(text)) {
    return WorldCupMarketType.Advance;
  }
  if (/\b(?:top\s+scorer|golden\s+boot|most\s+goals|leading\s+scorer)\b/.test(text)) {
    return WorldCupMarketType.TopScorer;
  }
  return WorldCupMarketType.Winner;
}

/** Try to extract and resolve a team code from a regex capture group. */
function tryExtractTeam(text: string, pattern: RegExp, groupIndex: number = 1): string | undefined {
  const match = text.match(pattern);
  if (!match?.[groupIndex]) return undefined;
  return resolveFromCandidate(cleanTeamToken(match[groupIndex]));
}

/** Try to resolve a single team name from a regex capture group (no progressive stripping). */
function tryExactTeam(text: string, pattern: RegExp, groupIndex: number = 1): string | undefined {
  const match = text.match(pattern);
  if (!match?.[groupIndex]) return undefined;
  return resolveWorldCupTeam(cleanTeamToken(match[groupIndex]));
}

/**
 * Extract the primary team code from the title by scanning for known aliases.
 * Tries explicit "will {team} …" patterns first, then scans the full text
 * for any known team alias.
 */
function extractTeamCode(text: string): string | undefined {
  // "Will Brazil win/be the champion of…"
  return tryExtractTeam(text, /will\s+([a-z][a-z\s.'’-]{1,30}?)\s+(?:win|beat|defeat|advance|qualify)\b/)
    // "{Team} to win the World Cup"
    ?? tryExtractTeam(text, /^([a-z][a-z\s.'’-]{1,30}?)\s+(?:to\s+)?win\b/)
    // "{Team} vs {Opponent}" — take the left-hand side.
    ?? tryExtractTeam(text, /([a-z][a-z\s.'’-]{1,20}?)\s+(?:vs\.?|versus)\s+/)
    // Last resort: scan the whole text for known team aliases via word boundary.
    ?? scanTeamAliases(text);
}

function extractOpponent(text: string, primaryTeam: string | undefined): string | undefined {
  // "Will {team} beat {opponent}"
  const beatResolved = tryExactTeam(text, /(?:beat|defeat|win\s+(?:against|over))\s+([a-z][a-z\s.'’-]{1,30}?)(?:\s+(?:in|at|during|\?|$))/);
  if (beatResolved && beatResolved !== primaryTeam) return beatResolved;

  // "{Left} vs {Right}" pattern
  // Greedy quantifier on opponent group + ":" in terminator to handle
  // titles like "Argentina vs Cape Verde: To Advance"
  const vsMatch = text.match(/([a-z][a-z\s.'’-]{1,20}?)\s+(?:vs\.?|versus)\s+([a-z][a-z\s.'’-]{1,30})(?:\s|$|[?.,:])/);
  if (vsMatch) {
    const left = resolveWorldCupTeam(cleanTeamToken(vsMatch[1]));
    const right = resolveWorldCupTeam(cleanTeamToken(vsMatch[2]));
    if (left && right && left !== right) {
      return left === primaryTeam ? right : left;
    }
  }

  return undefined;
}

function extractThreshold(text: string): number | undefined {
  const match = text.match(/(?:over|under|more\s+than|less\s+than)\s+(\d+(?:\.\d+)?)\s*(?:goal|point)/i);
  if (match?.[1]) return Number(match[1]);
  return undefined;
}

function extractGroupName(text: string): string | undefined {
  const match = text.match(/\bgroup\s+([A-Ha-h])\b/);
  return match?.[1]?.toUpperCase();
}

function buildSubject(teamCode: string | undefined, opponentCode: string | undefined): string {
  if (teamCode && opponentCode) return `${teamCode.toUpperCase()} vs ${opponentCode.toUpperCase()}`;
  if (teamCode) return teamCode.toUpperCase();
  return "general";
}

function cleanTeamToken(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/^\s*(the|a|an)\s+/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Try to resolve a candidate team string by progressively stripping words
 * from the right end. "team brazil" → "team brazil" fails → "team" fails →
 * then we also try just the last word "brazil". This handles titles like
 * "Team Brazil" or "the Brazilian National Team".
 */
function resolveFromCandidate(candidate: string): string | undefined {
  if (!candidate) return undefined;

  // Try the full candidate.
  const direct = resolveWorldCupTeam(candidate);
  if (direct) return direct;

  // Try stripping the last word repeatedly.
  const words = candidate.split(" ");
  for (let i = words.length - 1; i > 0; i--) {
    const shorter = words.slice(0, i).join(" ");
    const resolved = resolveWorldCupTeam(shorter);
    if (resolved) return resolved;
  }

  // Try individual words from right to left.
  for (let i = words.length - 1; i >= 0; i--) {
    const resolved = resolveWorldCupTeam(words[i]);
    if (resolved) return resolved;
  }

  return undefined;
}

/**
 * Scan the text for any known team alias by word boundary and return the
 * first match. Lower priority than the explicit patterns above; used as a
 * fallback when no structured pattern matches.
 */
function scanTeamAliases(text: string): string | undefined {
  // Sort aliases by length descending so "costa rica" matches before "costa".
  for (const canonical of WORLDCUP_TEAM_CODES) {
    // Build word-boundary pattern for the canonical code itself.
    if (new RegExp(`\\b${canonical}\\b`).test(text)) return canonical;
  }

  // Scan the full alias table via resolveWorldCupTeam on each 1–3 word window.
  const words = text.split(/\s+/);
  for (let len = 3; len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const window = words.slice(i, i + len).join(" ");
      const resolved = resolveWorldCupTeam(window);
      if (resolved) return resolved;
    }
  }

  return undefined;
}
