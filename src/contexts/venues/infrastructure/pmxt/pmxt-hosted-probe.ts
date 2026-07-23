import {
  createPmxtHostedClient,
  PmxtExchangeConstructor,
  PmxtHostedClientOptions,
} from "./pmxt-hosted-client-factory";
import { PmxtHostedVenueClient } from "./pmxt-hosted-venue-client";

export interface PmxtHostedProbeConfig {
  apiKey?: string;
  hostedBaseUrl?: string;
  pmxtShadowEnabled: boolean;
  pmxtShadowReadsEnabled: boolean;
  venue?: "kalshi" | "polymarket";
}

export interface PmxtHostedProbeDeps {
  print(message: string): void;
  newExchange?: PmxtExchangeConstructor;
}

export async function runPmxtHostedProbe(
  config: PmxtHostedProbeConfig,
  deps: PmxtHostedProbeDeps
): Promise<void> {
  if (!config.pmxtShadowEnabled) {
    deps.print("PMXT shadowing is disabled; probe skipped");
    return;
  }
  if (!config.pmxtShadowReadsEnabled) {
    deps.print("PMXT shadow reads are disabled; probe skipped");
    return;
  }

  const client = await createPmxtHostedClient(
    {
      apiKey: config.apiKey ?? "",
      hostedBaseUrl: config.hostedBaseUrl ?? "",
      pmxtShadowEnabled: config.pmxtShadowEnabled,
      pmxtShadowReadsEnabled: config.pmxtShadowReadsEnabled,
      venue: config.venue ?? "kalshi",
      autoStartServer: false,
    },
    deps.newExchange ? { newExchange: deps.newExchange } : undefined
  );

  const venueClient = new PmxtHostedVenueClient({
    listMarkets: () => client.fetchMarkets(),
    listOrderbooks: (outcomeIds) => client.fetchOrderBooks(outcomeIds),
    onDiagnostic: (message) => deps.print(message),
  });

  const markets = await venueClient.listMarkets();
  const books = await venueClient.listOrderbooks(markets);
  const staleCount = books.filter((book) => book.stale).length;

  deps.print(`PMXT hosted probe: markets=${markets.length} books=${books.length} stale=${staleCount}`);
}
