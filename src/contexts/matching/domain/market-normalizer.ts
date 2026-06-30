import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import {
  CryptoAsset,
  EventType,
  MarketOperator,
  NormalizedMarket,
  PayoffType,
  Topic,
} from "./normalized-market";

/**
 * General, deterministic normalizer for prediction markets across Kalshi and
 * Polymarket. Replaces the earlier crypto-only normalizer.
 *
 * Classification strategy:
 *   1. Classify topic from title + resolution text using keyword rules.
 *   2. Derive eventType, asset/subject, threshold, operator, deadline, and
 *      resolution source using topic-specific parsers.
 *   3. Emit topic-aware ambiguity flags (e.g. `subject_missing` for sports,
 *      `asset_missing` only for crypto/macro). Confidence is 0.95 when no
 *      flags are raised, otherwise 0.65.
 */
export class MarketNormalizer {
  normalize(snapshot: VenueMarketSnapshot): NormalizedMarket {
    const text = `${snapshot.title}\n${snapshot.rawResolutionText}`;
    const topic = classifyTopic(text);
    const eventType = classifyEventType(topic, text);
    const asset = parseAsset(topic, eventType, text);
    const threshold = parseThreshold(topic, eventType, text);
    const operator = parseOperator(topic, eventType, text);
    const payoffType = parsePayoffType(topic, eventType, text);
    const resolutionSource = parseResolutionSource(topic, text);
    const deadline = parseDeadline(text);
    const ambiguityFlags = ambiguityFlagsFor({
      topic,
      asset,
      threshold,
      operator,
      resolutionSource,
      deadline,
      eventType,
    });

    return {
      id: `${snapshot.venue}:${snapshot.venueMarketId}`,
      venue: snapshot.venue,
      venueMarketId: snapshot.venueMarketId,
      title: snapshot.title,
      rawResolutionText: snapshot.rawResolutionText,
      topic,
      eventType,
      asset,
      threshold,
      operator,
      deadline,
      timezone: deadline ? "UTC" : undefined,
      resolutionSource,
      payoffType,
      ambiguityFlags,
      confidence: ambiguityFlags.length === 0 ? 0.95 : 0.65,
    };
  }
}

// ---------------------------------------------------------------------------
// Topic classification
// ---------------------------------------------------------------------------

function classifyTopic(text: string): Topic {
  const lower = text.toLowerCase();

  // Crypto: keep existing keywords and add a few common tokens.
  if (
    /\b(bitcoin|btc|ethereum|eth|ether|crypto|cryptocurrency|blockchain|solana|cardano|ada|sol)\b/.test(
      lower
    )
  ) {
    return "crypto";
  }

  // Macro: economic indicators and central-bank language.
  if (
    /\b(cpi|inflation|fed funds|federal funds|interest rate|unemployment|gdp|recession|nfp|non-farm payrolls|consumer price index)\b/.test(
      lower
    )
  ) {
    return "macro";
  }

  // Politics: elections, nominations, office-seeking language. Checked before
  // sports so "Will Donald Trump win the 2024 US Presidential Election?" is
  // classified as politics even though it contains "win the".
  if (
    /\b(election|president|presidential|nominee|nomination|candidate|senate|congress|governor|vote|ballot|primary)\b/.test(
      lower
    )
  ) {
    return "politics";
  }

  // Sports: leagues, tournaments, win/winner/goal language, team-vs-team.
  if (
    /\b(world cup|fifa|nba|nfl|super bowl|olympics|championship|win the|win\b|winner|goal|goals|score|team|vs\.|versus|tournament)\b/.test(
      lower
    )
  ) {
    return "sports";
  }

  // Default: generic current-events yes/no markets.
  return "current_events";
}

// ---------------------------------------------------------------------------
// Event type classification
// ---------------------------------------------------------------------------

function classifyEventType(topic: Topic, text: string): EventType {
  const lower = text.toLowerCase();

  switch (topic) {
    case "crypto": {
      const operator = parseOperator(topic, "price_above", text);
      return operator === "<" || /\b(below|under|less than)\b/.test(lower) ? "price_below" : "price_above";
    }

    case "macro": {
      if (/\b(fed funds|federal funds|interest rate|fed rate)\b/.test(lower)) {
        return "fed_rate_decision";
      }
      if (/\b(cpi|consumer price index|inflation rate)\b/.test(lower)) {
        return "cpi_range";
      }
      return "yes_no";
    }

    case "sports": {
      if (
        /\b(total goals|over\/under|over\s+\d|under\s+\d|more than\s+\d+\s+goal|less than\s+\d+\s+goal)\b/.test(
          lower
        ) ||
        /\bhave\s+over\s+\d/.test(lower) ||
        /\bscore\s+(more than|less than)\b/.test(lower)
      ) {
        return "total";
      }
      if (
        /\bwin\b/.test(lower) ||
        /\bwin\s+the\b/.test(lower) ||
        /\bwinner\b/.test(lower) ||
        /\bchampionship\b/.test(lower) ||
        /\bwho\s+will\s+win\b/.test(lower)
      ) {
        return "winner";
      }
      return "yes_no";
    }

    case "politics": {
      if (
        /\bnomination\b/.test(lower) ||
        /\bnominee\b/.test(lower) ||
        /\bwin\s+the\s+.*\s+nomination\b/.test(lower)
      ) {
        return "nomination";
      }
      if (
        /\bwin\b/.test(lower) ||
        /\bwinner\b/.test(lower) ||
        /\belection\b/.test(lower) ||
        /\bwho\s+will\s+win\b/.test(lower)
      ) {
        return "winner";
      }
      return "yes_no";
    }

    case "current_events":
    default:
      return "yes_no";
  }
}

// ---------------------------------------------------------------------------
// Asset / subject parsing
// ---------------------------------------------------------------------------

function parseAsset(
  topic: Topic,
  eventType: EventType,
  text: string
): CryptoAsset | string | undefined {
  const lower = text.toLowerCase();

  if (topic === "crypto") {
    if (/\b(bitcoin|btc)\b/.test(lower)) return "BTC";
    if (/\b(ethereum|ether|eth)\b/.test(lower)) return "ETH";
    return undefined;
  }

  if (topic === "sports") {
    // Matchup totals: "Will Argentina vs Brazil have over 2.5 goals?"
    const matchup = lower.match(
      /will\s+([a-z][a-z\s\.'-]*?)\s+(?:vs\.?|versus)\s+([a-z][a-z\s\.'-]*?)\s+(?:have|score|play)/
    );
    if (matchup) {
      const left = cleanSubject(matchup[1]);
      const right = cleanSubject(matchup[2]);
      return `${left} vs ${right}`;
    }

    // Winner: "Will Ghana win the 2026 FIFA World Cup?"
    const winner = lower.match(
      /will\s+([a-z][a-z\s\.'-]*?)\s+(?:win|be the winner|become the winner|be\s+champion)/
    );
    if (winner) return cleanSubject(winner[1]);

    // "Who will win the 2026 FIFA World Cup?" -> use the event name as subject.
    const event = extractEventName(lower);
    if (event) return event;

    return undefined;
  }

  if (topic === "politics") {
    // Nomination: "Will Donald Trump win the Republican nomination?"
    const personParty = lower.match(
      /will\s+([a-z][a-z\s\.'-]*?)\s+(?:win|secure|earn)\s+(?:the\s+)?([a-z]+(?:\s+party)?\s+nomination)/
    );
    if (personParty) {
      return `${cleanSubject(personParty[1])} (${cleanSubject(personParty[2])})`;
    }

    // Election winner: "Will Donald Trump win the 2024 US Presidential Election?"
    const personOffice = lower.match(
      /will\s+([a-z][a-z\s\.'-]*?)\s+(?:win|be elected to|become)\s+(?:the\s+)?([0-9]{4}\s+[a-z][a-z\s]*election)/
    );
    if (personOffice) {
      return `${cleanSubject(personOffice[1])} (${cleanSubject(personOffice[2])})`;
    }

    // Office-only election: "2024 US Presidential Election"
    const officeOnly = lower.match(
      /([0-9]{4}\s+[a-z][a-z\s]*(?:presidential|senate|congressional|gubernatorial|primary)\s+election)/
    );
    if (officeOnly) return cleanSubject(officeOnly[1]);

    // Generic candidate/person after "Will".
    const generic = lower.match(/will\s+([a-z][a-z\s\.'-]*?)\s+(?:win|be elected|be the nominee)/);
    if (generic) return cleanSubject(generic[1]);

    return undefined;
  }

  if (topic === "current_events") {
    // "Will X happen..." -> subject is the clause between "Will" and the
    // first boundary word (happen/by/before/on/?).
    const clause = lower.match(/will\s+([a-z][a-z0-9\s\.'-]{0,60}?)(?:\s+happen|\s+by|\s+before|\s+on|\?)/);
    if (clause) {
      const cleaned = cleanSubject(clause[1]);
      // Drop a trailing "happen" token if the regex consumed it into the group.
      return cleaned.replace(/\s+happen$/, "").trim();
    }
    return undefined;
  }

  return undefined;
}

function cleanSubject(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
}

function extractEventName(lower: string): string | undefined {
  const eventMatch = lower.match(
    /(?:the\s+)?([0-9]{4}\s+(?:fifa\s+world\s+cup|world\s+cup|olympics|nba\s+finals|super\s+bowl|nfl\s+season|nba\s+season|olympic\s+games))/
  );
  if (eventMatch) return cleanSubject(eventMatch[1]);
  return undefined;
}

// ---------------------------------------------------------------------------
// Threshold parsing
// ---------------------------------------------------------------------------

function parseThreshold(
  topic: Topic,
  eventType: EventType,
  text: string
): number | undefined {
  const lower = text.toLowerCase();

  if (topic === "crypto") {
    return parseCryptoThreshold(text);
  }

  if (topic === "sports" && eventType === "total") {
    // "over 2.5 goals", "under 2.5", "total goals 2.5", "more than 2 goals"
    const match =
      lower.match(/(?:over|under|more than|less than)\s+(\d+(?:\.\d+)?)\s*(?:goal|goals)/) ||
      lower.match(/total\s+goals\s*(?:over|under)?\s*(\d+(?:\.\d+)?)/) ||
      lower.match(/have\s+(?:over|under)\s+(\d+(?:\.\d+)?)/);
    if (match) return numericThresholdFromMatch(match);
  }

  if (topic === "macro") {
    // Reject bare year-like numbers (e.g. "between 2024 and 2025") unless they
    // carry an explicit unit (% / bps / points). This avoids treating years as
    // economic thresholds.
    const macroMatch = lower.match(
      /(?:above|below|greater than|less than|between)\s+(\d+(?:\.\d+)?)(%|\s*(?:bps|basis points?|points?))?/i
    );
    if (macroMatch) {
      const value = Number(macroMatch[1]);
      const unit = macroMatch[2] ?? "";
      const hasUnit = /%|bps|basis|point/.test(unit);
      if (hasUnit || !isYearLikeNumber(value)) {
        return numericThresholdFromMatch(macroMatch);
      }
    }
  }

  return undefined;
}

function parseCryptoThreshold(text: string): number | undefined {
  const thresholdPatterns = [
    /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s?(?:k|K))?/,
    /(?:above|over|below|under|greater than|less than|touch)\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s?(?:k|K))?/i,
  ];

  for (const pattern of thresholdPatterns) {
    const match = text.match(pattern);
    const threshold = match ? numericThresholdFromMatch(match) : undefined;
    if (threshold !== undefined) return threshold;
  }

  return undefined;
}

function isYearLikeNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}
function numericThresholdFromMatch(match: RegExpMatchArray): number | undefined {
  if (!match[1]) return undefined;
  const raw = match[1].replace(/,/g, "");
  const multiplier = /[0-9](?:\s?)[kK]\b/.test(match[0]) ? 1000 : 1;
  const value = Number(raw) * multiplier;
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Operator parsing
// ---------------------------------------------------------------------------

function parseOperator(
  topic: Topic,
  eventType: EventType,
  text: string
): MarketOperator | undefined {
  const lower = text.toLowerCase();

  if (topic === "crypto") {
    if (/\b(above|over|greater than|exceed|touch)\b/i.test(text)) return ">";
    if (/\b(below|under|less than)\b/i.test(text)) return "<";
    return undefined;
  }

  if (topic === "sports" && eventType === "total") {
    if (/\b(over|more than|above)\b/.test(lower)) return ">";
    if (/\b(under|less than|below)\b/.test(lower)) return "<";
    if (/\bbetween\b/.test(lower)) return "between";
    return undefined;
  }

  if (topic === "macro") {
    if (/\bbetween\b/.test(lower)) return "between";
    if (/\b(above|over|greater than)\b/.test(lower)) return ">";
    if (/\b(below|under|less than)\b/.test(lower)) return "<";
    return undefined;
  }

  // winner / nomination / yes_no have no numeric operator.
  return undefined;
}

// ---------------------------------------------------------------------------
// Payoff type parsing
// ---------------------------------------------------------------------------

function parsePayoffType(
  topic: Topic,
  eventType: EventType,
  text: string
): PayoffType {
  const lower = text.toLowerCase();

  if (topic === "crypto") {
    if (/\b(any point|any time|touch|before)\b/i.test(lower)) return "any_time_before";
    return "at_time";
  }

  if (topic === "macro") {
    if (/\b(range|between)\b/.test(lower)) return "range";
    if (/\b(settlement|fixing|closing)\b/.test(lower)) return "settlement_value";
    return "at_time";
  }

  if (topic === "sports" && eventType === "total") {
    // A total "at any point" (e.g. "Will Team A score more than 2 goals at any
    // point during the tournament?") is unusual; default to at_time for a
    // single match total.
    if (/\b(any point|at any time)\b/.test(lower)) return "any_time_before";
    return "at_time";
  }

  // winner, nomination, yes_no all resolve at a specific deadline.
  return "at_time";
}

// ---------------------------------------------------------------------------
// Resolution source parsing
// ---------------------------------------------------------------------------

function parseResolutionSource(
  topic: Topic,
  text: string
): string | undefined {
  const lower = text.toLowerCase();

  // Explicit source patterns take precedence.
  const usingMatch = text.match(/using\s+(.+?)\s+at\s+\d{4}-\d{2}-\d{2}T/i);
  if (usingMatch?.[1]) return usingMatch[1].trim();

  const simpleMatch = text.match(/source\s*[:=]\s*(.+)$/i);
  if (simpleMatch?.[1] && !/unclear|unknown/i.test(simpleMatch[1])) {
    return simpleMatch[1].trim();
  }

  if (/\bresolves\s+based\s+on\s+(.+?)\s+(?:at|on|by)\b/i.test(text)) {
    const m = text.match(/\bresolves\s+based\s+on\s+(.+?)\s+(?:at|on|by)\b/i);
    if (m?.[1]) return m[1].trim();
  }

  // Topic-specific sensible defaults.
  if (topic === "sports") {
    if (/\bfifa\b/.test(lower) || /\bworld cup\b/.test(lower)) {
      return "official FIFA result";
    }
    if (/\bnba\b/.test(lower)) return "official NBA result";
    if (/\bnfl\b/.test(lower) || /\bsuper bowl\b/.test(lower)) {
      return "official NFL result";
    }
    if (/\bolympics\b/.test(lower)) return "official Olympic result";
    return "official sports result";
  }

  if (topic === "politics") return "official election result";
  if (topic === "macro") {
    if (/\bcpi\b/.test(lower)) return "Bureau of Labor Statistics CPI report";
    if (/\bfed\b/.test(lower)) return "Federal Reserve policy announcement";
    return "official government data release";
  }

  // Current events and crypto fallbacks: leave undefined so the scanner can
  // request LLM review when the source is not explicit.
  return undefined;
}

// ---------------------------------------------------------------------------
// Deadline parsing
// ---------------------------------------------------------------------------

function parseDeadline(text: string): string | undefined {
  const lower = text.toLowerCase();

  // ISO-like timestamps.
  // Issue #49: validate the parsed date before calling toISOString — an
  // out-of-range ISO string produces an Invalid Date whose toISOString()
  // throws RangeError, which would fail the whole normalization path.
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  if (isoMatch) {
    const date = new Date(isoMatch[0]);
    if (!Number.isFinite(date.getTime())) return undefined;
    return date.toISOString();
  }

  // "Jan 1, 2026" / "January 1, 2026"
  const janMatch = text.match(/Jan(?:uary)?\s+([0-9]{1,2}),\s*([0-9]{4})/i);
  if (janMatch) {
    const day = Number(janMatch[1]);
    const year = Number(janMatch[2]);
    const date = new Date(Date.UTC(year, 0, day, 0, 0, 0));
    // Issue #49: reject out-of-range day values that roll over into the next
    // month (e.g. Jan 32 -> Feb 1) before toISOString can produce a wrong date.
    if (!Number.isFinite(date.getTime()) || date.getUTCDate() !== day) return undefined;
    return date.toISOString();
  }

  // Generic month-day-year phrases with prepositions/keywords.
  // Issue #50: collect all matches, preferring resolution keywords (resolves,
  // by, before, expires) over generic "on"/"at" dates, and preferring the
  // latest date when multiple candidates exist. This prevents an early
  // "on <event date>" from shadowing a later "resolves by <deadline>".
  const monthYearPattern =
    /(?:(resolves?|expires?)\s+)?(by\s+|before\s+|until\s+|on\s+|at\s+)(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-9]{1,2}),?\s*([0-9]{4})/gi;

  const resolutionDates: number[] = [];
  const genericDates: number[] = [];

  let monthYearMatch: RegExpExecArray | null;
  while ((monthYearMatch = monthYearPattern.exec(text)) !== null) {
    const prefixKeyword = monthYearMatch[1]?.toLowerCase();
    const preposition = monthYearMatch[2]?.toLowerCase().trim();
    const month = monthNameToIndex(monthYearMatch[3]);
    const day = Number(monthYearMatch[4]);
    const year = Number(monthYearMatch[5]);
    if (month === undefined) continue;

    const ts = Date.UTC(year, month, day, 0, 0, 0);
    // Issue #49: skip invalid/out-of-range dates instead of letting
    // toISOString throw RangeError.
    if (!Number.isFinite(ts)) continue;
    // Issue #49: reject rolled-over dates (e.g. Dec 32 -> Jan 1 of next year).
    const constructed = new Date(ts);
    if (constructed.getUTCDate() !== day || constructed.getUTCMonth() !== month) continue;

    const isResolution =
      prefixKeyword !== undefined ||
      preposition === "by" ||
      preposition === "before" ||
      preposition === "until";

    if (isResolution) {
      resolutionDates.push(ts);
    } else {
      genericDates.push(ts);
    }
  }

  const candidates =
    resolutionDates.length > 0 ? resolutionDates : genericDates;
  if (candidates.length > 0) {
    return new Date(Math.max(...candidates)).toISOString();
  }
  // Just a year with an event name: "2026 FIFA World Cup" -> final is July 19, 2026.
  if (/2026\s+fifa\s+world\s+cup(?:\s*$|\s*\?)/.test(lower)) {
    return new Date(Date.UTC(2026, 6, 19, 0, 0, 0)).toISOString();
  }
  if (/2024\s+us\s+presidential\s+election(?:\s*$|\s*\?)/.test(lower)) {
    return new Date(Date.UTC(2024, 10, 5, 0, 0, 0)).toISOString();
  }

  return undefined;
}

function monthNameToIndex(name: string): number | undefined {
  const map: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  return map[name.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Ambiguity flags
// ---------------------------------------------------------------------------

function ambiguityFlagsFor(input: {
  topic: Topic;
  asset?: string;
  threshold?: number;
  operator?: MarketOperator;
  resolutionSource?: string;
  deadline?: string;
  eventType: EventType;
}): string[] {
  const flags: string[] = [];

  // For crypto/macro the numeric asset matters; for other topics we talk about
  // a subject instead.
  if (!input.asset) {
    if (input.topic === "crypto" || input.topic === "macro") {
      flags.push("asset_missing");
    } else {
      flags.push("subject_missing");
    }
  }

  // Threshold is required for crypto price markets and sports totals; leave
  // undefined for winner/nomination/yes_no.
  if (
    input.threshold === undefined &&
    (input.topic === "crypto" ||
      (input.topic === "sports" && input.eventType === "total") ||
      (input.topic === "macro" &&
        (input.eventType === "fed_rate_decision" || input.eventType === "cpi_range")))
  ) {
    flags.push("threshold_missing");
  }

  // Operator is required when a threshold is expected.
  if (!input.operator && input.threshold !== undefined) {
    flags.push("operator_missing");
  }

  // Resolution source missing only when no sensible default was inferred.
  if (!input.resolutionSource) {
    flags.push("resolution_source_missing");
  }

  if (!input.deadline) {
    flags.push("deadline_missing");
  }

  return flags;
}
