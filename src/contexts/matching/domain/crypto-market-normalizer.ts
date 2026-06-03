import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { EventType, MarketOperator, NormalizedMarket, PayoffType } from "./normalized-market";

export class CryptoMarketNormalizer {
  normalize(snapshot: VenueMarketSnapshot): NormalizedMarket {
    const text = `${snapshot.title}\n${snapshot.rawResolutionText}`;
    const asset = parseAsset(text);
    const threshold = parseThreshold(text);
    const operator = parseOperator(text);
    const payoffType = parsePayoffType(text);
    const resolutionSource = parseResolutionSource(snapshot.rawResolutionText);
    const deadline = parseDeadline(text);
    const ambiguityFlags = ambiguityFlagsFor({ asset, threshold, operator, resolutionSource, deadline });

    return {
      id: `${snapshot.venue}:${snapshot.venueMarketId}`,
      venue: snapshot.venue,
      venueMarketId: snapshot.venueMarketId,
      title: snapshot.title,
      rawResolutionText: snapshot.rawResolutionText,
      topic: "crypto",
      eventType: eventTypeFor(operator),
      asset,
      threshold,
      operator,
      deadline,
      timezone: deadline ? "UTC" : undefined,
      resolutionSource,
      payoffType,
      ambiguityFlags,
      confidence: ambiguityFlags.length === 0 ? 0.95 : 0.65
    };
  }
}

function parseAsset(text: string): NormalizedMarket["asset"] {
  if (/\b(bitcoin|btc)\b/i.test(text)) return "BTC";
  if (/\b(ethereum|ether|eth)\b/i.test(text)) return "ETH";
  return undefined;
}

function parseThreshold(text: string): number | undefined {
  const thresholdPatterns = [
    /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s?(?:k|K))?/,
    /(?:above|over|below|under|greater than|less than|touch)\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s?(?:k|K))?/i
  ];

  for (const pattern of thresholdPatterns) {
    const match = text.match(pattern);
    const threshold = match ? numericThresholdFromMatch(match) : undefined;
    if (threshold !== undefined) return threshold;
  }

  return undefined;
}

function numericThresholdFromMatch(match: RegExpMatchArray): number | undefined {
  if (!match[1]) return undefined;
  const raw = match[1].replace(/,/g, "");
  const multiplier = /[0-9](?:\s?)[kK]\b/.test(match[0]) ? 1000 : 1;
  const value = Number(raw) * multiplier;
  return Number.isFinite(value) ? value : undefined;
}

function parseOperator(text: string): MarketOperator | undefined {
  if (/\b(above|over|greater than|exceed|touch)\b/i.test(text)) return ">";
  if (/\b(below|under|less than)\b/i.test(text)) return "<";
  return undefined;
}

function eventTypeFor(operator?: MarketOperator): EventType {
  return operator === "<" || operator === "<=" ? "price_below" : "price_above";
}

function parsePayoffType(text: string): PayoffType {
  if (/\b(any point|any time|touch|before)\b/i.test(text)) return "any_time_before";
  return "at_time";
}

function parseResolutionSource(text: string): string | undefined {
  const sourceMatch = text.match(/using\s+(.+?)\s+at\s+\d{4}-\d{2}-\d{2}T/i);
  if (sourceMatch?.[1]) return sourceMatch[1].trim();
  const simpleMatch = text.match(/source\s*[:=]\s*(.+)$/i);
  if (simpleMatch?.[1] && !/unclear|unknown/i.test(simpleMatch[1])) return simpleMatch[1].trim();
  return undefined;
}

function parseDeadline(text: string): string | undefined {
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  if (isoMatch) return new Date(isoMatch[0]).toISOString();

  const janMatch = text.match(/Jan(?:uary)?\s+([0-9]{1,2}),\s*([0-9]{4})/i);
  if (janMatch) {
    const day = Number(janMatch[1]);
    const year = Number(janMatch[2]);
    return new Date(Date.UTC(year, 0, day, 0, 0, 0)).toISOString();
  }

  return undefined;
}

function ambiguityFlagsFor(input: {
  asset?: NormalizedMarket["asset"];
  threshold?: number;
  operator?: MarketOperator;
  resolutionSource?: string;
  deadline?: string;
}): string[] {
  const flags: string[] = [];
  if (!input.asset) flags.push("asset_missing");
  if (input.threshold === undefined) flags.push("threshold_missing");
  if (!input.operator) flags.push("operator_missing");
  if (!input.resolutionSource) flags.push("resolution_source_missing");
  if (!input.deadline) flags.push("deadline_missing");
  return flags;
}
