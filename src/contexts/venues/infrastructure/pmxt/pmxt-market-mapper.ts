export interface PmxtOutcome {
  id: string;
  label?: string;
}

export interface PmxtMarket {
  id: string;
  title?: string;
  description?: string;
  outcomes: PmxtOutcome[];
  [key: string]: unknown;
}

export interface PmxtMarketSnapshot {
  venue: "pmxt";
  venueMarketId: string;
  title: string;
  rawResolutionText: string;
  capturedAt: string;
  rawPayload: Record<string, unknown>;
}

export function mapPmxtMarketToSnapshot(
  market: PmxtMarket,
  capturedAt: string
): PmxtMarketSnapshot {
  if (!market.id || typeof market.id !== "string" || market.id.trim().length === 0) {
    throw new Error("PMXT market id is missing");
  }
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) {
    throw new Error("PMXT market has no explicit outcomes");
  }
  if (market.outcomes.length !== 2) {
    throw new Error("PMXT market is not binary");
  }

  const outcomeIds: string[] = [];
  for (const outcome of market.outcomes) {
    if (!outcome || typeof outcome.id !== "string" || outcome.id.trim().length === 0) {
      throw new Error("PMXT outcome identity is ambiguous");
    }
    outcomeIds.push(outcome.id.trim());
  }

  const labels = market.outcomes.map((outcome) =>
    typeof outcome.label === "string" ? outcome.label.trim().toLowerCase() : ""
  );
  const yesIndex = labels.indexOf("yes");
  const noIndex = labels.indexOf("no");
  if (yesIndex === -1 || noIndex === -1 || yesIndex === noIndex) {
    throw new Error("PMXT outcome orientation is ambiguous");
  }

  return {
    venue: "pmxt",
    venueMarketId: market.id.trim(),
    title: typeof market.title === "string" && market.title.trim().length > 0
      ? market.title.trim()
      : market.id.trim(),
    rawResolutionText: typeof market.description === "string" ? market.description.trim() : "",
    capturedAt,
    rawPayload: {
      ...market,
      yesOutcomeId: outcomeIds[yesIndex],
      noOutcomeId: outcomeIds[noIndex],
    },
  };
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
