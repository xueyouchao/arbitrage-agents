export interface PmxtPriceLevel {
  price: number;
  size: number;
}

export interface PmxtSdkOrderBook {
  bids?: PmxtPriceLevel[];
  asks?: PmxtPriceLevel[];
  [key: string]: unknown;
}

export interface PmxtMarketBook {
  marketId: string;
  venue: "pmxt";
  yesAsk?: number;
  noAsk?: number;
  yesAvailableUsd: number;
  noAvailableUsd: number;
  yesDepth: PmxtPriceLevel[];
  noDepth: PmxtPriceLevel[];
  capturedAt: string;
  stale: boolean;
  rawPayload: Record<string, unknown>;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function parsePriceLevel(raw: unknown): PmxtPriceLevel {
  if (!raw || typeof raw !== "object") {
    throw new Error("PMXT price level is malformed");
  }
  const level = raw as Record<string, unknown>;
  const price = Number(level.price);
  const size = Number(level.size);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error("PMXT price is ambiguous");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("PMXT size unit is ambiguous");
  }
  return { price, size };
}

function parseSide(levels: unknown): PmxtPriceLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels.map(parsePriceLevel).sort((a, b) => a.price - b.price);
}

export function mapPmxtOrderbookToMarketBook(
  marketId: string,
  yesBook: PmxtSdkOrderBook,
  noBook: PmxtSdkOrderBook,
  capturedAt: string
): PmxtMarketBook {
  if (!marketId || typeof marketId !== "string" || marketId.trim().length === 0) {
    throw new Error("PMXT orderbook market id is missing");
  }

  const yesDepth = parseSide(yesBook.asks);
  const noDepth = parseSide(noBook.asks);
  const yesAskLevel = yesDepth[0];
  const noAskLevel = noDepth[0];

  return {
    marketId: marketId.trim(),
    venue: "pmxt",
    yesAsk: yesAskLevel?.price,
    noAsk: noAskLevel?.price,
    yesAvailableUsd: yesAskLevel ? roundUsd(yesAskLevel.price * yesAskLevel.size) : 0,
    noAvailableUsd: noAskLevel ? roundUsd(noAskLevel.price * noAskLevel.size) : 0,
    yesDepth,
    noDepth,
    capturedAt,
    stale: !yesAskLevel || !noAskLevel,
    rawPayload: { yesBook, noBook },
  };
}
