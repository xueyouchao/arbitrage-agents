export interface PmxtOutcome {
  id?: string;
  outcomeId?: string;
  label?: string;
}

export interface PmxtMarket {
  id?: string;
  marketId?: string;
  slug?: string;
  contractAddress?: string;
  title?: string;
  description?: string;
  outcomes: PmxtOutcome[];
  [key: string]: unknown;
}

export interface PmxtMarketSnapshot {
  venue: "pmxt";
  venueMarketId: string;
  catalogMarketId?: string;
  sourceExchange?: "kalshi" | "polymarket";
  title: string;
  rawResolutionText: string;
  capturedAt: string;
  rawPayload: Record<string, unknown>;
}

export interface PmxtMarketMappingStamp {
  sourceExchange: "kalshi" | "polymarket";
  nativeMarketIdentity:
    | { kind: "ticker"; value: string }
    | { kind: "conditionId"; value: string };
  outcomeOrientation?: {
    yesOutcomeId: string;
    noOutcomeId: string;
  };
}

export function mapPmxtMarketToSnapshot(
  market: PmxtMarket,
  capturedAt: string,
  stamp?: PmxtMarketMappingStamp
): PmxtMarketSnapshot {
  const catalogMarketId = readIdentity(market.marketId ?? market.id);
  if (!catalogMarketId) {
    throw new Error("PMXT market id is missing");
  }
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) {
    throw new Error("PMXT market has no explicit outcomes");
  }
  if (market.outcomes.length !== 2) {
    throw new Error("PMXT market is not binary");
  }

  const outcomeIds = market.outcomes.map((outcome) => {
    const outcomeId = outcome && readIdentity(outcome.outcomeId ?? outcome.id);
    if (!outcomeId) {
      throw new Error("PMXT outcome identity is ambiguous");
    }
    return outcomeId;
  });
  const orientation = resolveOrientation(market, outcomeIds, stamp?.outcomeOrientation);
  const venueMarketId = stamp
    ? verifyNativeIdentity(market, stamp)
    : catalogMarketId;
  const title = typeof market.title === "string" && market.title.trim().length > 0
    ? market.title.trim()
    : catalogMarketId;

  return {
    venue: "pmxt",
    venueMarketId,
    ...(stamp ? { catalogMarketId, sourceExchange: stamp.sourceExchange } : {}),
    title,
    rawResolutionText: typeof market.description === "string" ? market.description.trim() : "",
    capturedAt,
    rawPayload: {
      ...market,
      yesOutcomeId: orientation.yes,
      noOutcomeId: orientation.no,
    },
  };
}

function resolveOrientation(
  market: PmxtMarket,
  outcomeIds: string[],
  explicit?: { yesOutcomeId: string; noOutcomeId: string }
): { yes: string; no: string } {
  if (explicit) {
    const yes = readIdentity(explicit.yesOutcomeId);
    const no = readIdentity(explicit.noOutcomeId);
    if (!yes || !no || yes === no || !outcomeIds.includes(yes) || !outcomeIds.includes(no)) {
      throw new Error("PMXT outcome orientation is ambiguous");
    }
    return { yes, no };
  }

  const labels = market.outcomes.map((outcome) =>
    typeof outcome.label === "string" ? outcome.label.trim().toLowerCase() : ""
  );
  const yesIndex = labels.indexOf("yes");
  const noIndex = labels.indexOf("no");
  if (yesIndex === -1 || noIndex === -1 || yesIndex === noIndex) {
    throw new Error("PMXT outcome orientation is ambiguous");
  }
  return { yes: outcomeIds[yesIndex], no: outcomeIds[noIndex] };
}

function verifyNativeIdentity(market: PmxtMarket, stamp: PmxtMarketMappingStamp): string {
  const value = readIdentity(stamp.nativeMarketIdentity.value);
  if (!value) {
    throw new Error("PMXT venue-native market identity is missing");
  }
  if (stamp.sourceExchange === "kalshi" && stamp.nativeMarketIdentity.kind === "ticker") {
    if (readIdentity(market.slug) !== value) {
      throw new Error("PMXT Kalshi ticker is not proven by the market payload");
    }
    return value;
  }
  if (stamp.sourceExchange === "polymarket" && stamp.nativeMarketIdentity.kind === "conditionId") {
    if (readIdentity(market.contractAddress) !== value) {
      throw new Error("PMXT Polymarket conditionId is not proven by the market payload");
    }
    return value;
  }
  throw new Error("PMXT venue-native market identity does not match source exchange");
}

function readIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function outcomeIdsFor(market: PmxtMarketSnapshot): { yes: string; no: string } {
  const payload = market.rawPayload;
  const yes = typeof payload.yesOutcomeId === "string" ? payload.yesOutcomeId : undefined;
  const no = typeof payload.noOutcomeId === "string" ? payload.noOutcomeId : undefined;
  if (!yes || !no) {
    throw new Error(`PMXT market ${market.venueMarketId} lacks explicit YES/NO outcome ids`);
  }
  return { yes, no };
}
