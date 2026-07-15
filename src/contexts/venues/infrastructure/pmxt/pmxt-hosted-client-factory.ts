export interface PmxtHostedClientOptions {
  apiKey: string;
  hostedBaseUrl: string;
  pmxtShadowEnabled: boolean;
  pmxtShadowReadsEnabled: boolean;
  autoStartServer?: boolean;
}

export interface PmxtHostedReadOnlyClient {
  fetchMarkets(): Promise<unknown[]>;
  fetchOrderBooks(outcomeIds: string[]): Promise<Record<string, unknown>>;
}

export interface PmxtExchangeConstructor {
  new (options?: Record<string, unknown>): {
    fetchMarkets(): Promise<unknown[]>;
    fetchOrderBooks(outcomeIds: { outcomeId: string }[]): Promise<Record<string, unknown>>;
  };
}

export async function createPmxtHostedClient(
  options: PmxtHostedClientOptions,
  deps: { newExchange: PmxtExchangeConstructor } = {
    newExchange: require("pmxtjs").Mock,
  }
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

  const exchange = new deps.newExchange({
    pmxtApiKey: options.apiKey,
    baseUrl: options.hostedBaseUrl,
    autoStartServer: false,
  });

  return {
    fetchMarkets: () => exchange.fetchMarkets(),
    fetchOrderBooks: (outcomeIds: string[]) =>
      exchange.fetchOrderBooks(outcomeIds.map((outcomeId) => ({ outcomeId }))),
  };
}
