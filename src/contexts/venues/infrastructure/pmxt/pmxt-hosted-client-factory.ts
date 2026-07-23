import type { EventFetchParams, MarketFetchParams } from "pmxtjs";

export interface PmxtHostedClientOptions {
  apiKey: string;
  hostedBaseUrl: string;
  pmxtShadowEnabled: boolean;
  pmxtShadowReadsEnabled: boolean;
  venue: "kalshi" | "polymarket";
  autoStartServer?: boolean;
}

export type PmxtMarketFetchParams = MarketFetchParams;
export type PmxtEventFetchParams = EventFetchParams;

export interface PmxtHostedReadOnlyClient {
  fetchMarkets(params?: PmxtMarketFetchParams): Promise<unknown[]>;
  fetchEvents(params?: PmxtEventFetchParams): Promise<unknown[]>;
  fetchOrderBooks(outcomeIds: string[]): Promise<Record<string, unknown>>;
}

export interface PmxtExchange {
  fetchMarkets(params?: PmxtMarketFetchParams): Promise<unknown[]>;
  fetchEvents?(params?: PmxtEventFetchParams): Promise<unknown[]>;
  fetchOrderBooks(outcomeIds: { outcomeId: string }[]): Promise<Record<string, unknown>>;
}

export interface PmxtExchangeConstructor {
  new (options?: Record<string, unknown>): PmxtExchange;
}

export interface PmxtHostedClientDeps {
  newKalshi: PmxtExchangeConstructor;
  newPolymarket: PmxtExchangeConstructor;
}

export async function createPmxtHostedClient(
  options: PmxtHostedClientOptions,
  deps?: PmxtHostedClientDeps | { newExchange: PmxtExchangeConstructor }
): Promise<PmxtHostedReadOnlyClient> {
  if (!options.pmxtShadowEnabled) {
    throw new Error("PMXT shadowing is disabled");
  }
  if (!options.pmxtShadowReadsEnabled) {
    throw new Error("PMXT shadow reads are disabled");
  }
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    throw new Error("PMXT_API_KEY is required");
  }
  if (!options.hostedBaseUrl || options.hostedBaseUrl.trim().length === 0) {
    throw new Error("PMXT_HOSTED_BASE_URL is required");
  }
  const autoStartServer = options.autoStartServer ?? false;
  if (autoStartServer !== false) {
    throw new Error("autoStartServer must be false");
  }

  const constructors = deps ?? loadPmxtConstructors();
  const ExchangeConstructor = "newExchange" in constructors
    ? constructors.newExchange
    : options.venue === "polymarket"
      ? constructors.newPolymarket
      : constructors.newKalshi;
  const exchange = new ExchangeConstructor({
    pmxtApiKey: options.apiKey,
    baseUrl: options.hostedBaseUrl,
    autoStartServer: false,
  });

  return {
    fetchMarkets: (params) => exchange.fetchMarkets(params),
    fetchEvents: (params) => {
      if (!exchange.fetchEvents) {
        throw new Error("PMXT exchange does not support fetchEvents");
      }
      return exchange.fetchEvents(params);
    },
    fetchOrderBooks: (outcomeIds: string[]) =>
      exchange.fetchOrderBooks(outcomeIds.map((outcomeId) => ({ outcomeId }))),
  };
}

function loadPmxtConstructors(): PmxtHostedClientDeps {
  const pmxtjs = require("pmxtjs");
  return { newKalshi: pmxtjs.Kalshi, newPolymarket: pmxtjs.Polymarket };
}
