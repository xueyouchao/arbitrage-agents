// PMXT vs native opportunity-scanner comparison harness.
//
// Goal (per /goal): run the PMXT hosted read path and the native Kalshi/Polymarket
// read path side by side through the SAME shared domain pipeline (normalizer,
// candidate-pair generator, deterministic equivalence policy, opportunity
// calculator), with frozen identical calculator options, and diff the resulting
// candidate-pair and opportunity sets with per-pair reason codes — not just
// whole-array equality.
//
// This is a no-DB dry run. It writes nothing to Postgres and never touches
// production persistence. PMXT results are canonicalized to native venue
// identity (kalshi/polymarket) exactly like PmxtReadParityPipeline does, so
// the two paths are directly comparable.
//
// Usage:
//   node dist/scripts/compare-pmxt-scanner.js
//
// Env (all optional except PMXT creds for the PMXT side):
//   PMXT_API_KEY, PMXT_HOSTED_BASE_URL        — required to run the PMXT side live
//   KALSHI_SERIES_TICKER (default KXBTCD)
//   POLYMARKET_SERIES_SLUG (default btc-multi-strikes-weekly)
//   COMPARE_NATIVE_ONLY=1                     — skip PMXT, run native only
//   COMPARE_PMXT_VENUE=kalshi|polymarket|both — which PMXT exchange to query
//   COMPARE_MARKET_LIMIT=<n>                  — cap markets per venue (latency)

import "reflect-metadata";

// Load .env so PMXT_API_KEY / PMXT_HOSTED_BASE_URL written there are visible
// to process.env (the app itself does not call dotenv.config()). This is a
// harness convenience; it never writes anything.
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

import { KalshiPublicVenueClient, PolymarketPublicVenueClient } from "../src/contexts/venues/infrastructure/http-venue-clients";
import { VenueClient, VenueMarketSnapshot } from "../src/contexts/venues/domain/venue-market";
import { MarketBook } from "../src/contexts/arbitrage/domain/opportunity";
import { MarketNormalizer } from "../src/contexts/matching/domain/market-normalizer";
import { NormalizedMarket, Venue } from "../src/contexts/matching/domain/normalized-market";
import { CandidatePair, EquivalenceDecision } from "../src/contexts/matching/domain/candidate-pair";
import { CandidatePairGenerator } from "../src/contexts/matching/domain/candidate-pair-generator";
import { DeterministicEquivalencePolicy } from "../src/contexts/matching/domain/equivalence-policy";
import { OpportunityCalculator, OpportunityCalculatorOptions } from "../src/contexts/arbitrage/domain/opportunity-calculator";
import { CrossVenueOpportunity } from "../src/contexts/arbitrage/domain/opportunity";
import {
  mapPmxtMarketToSnapshot,
  PmxtMarket,
  PmxtMarketSnapshot,
} from "../src/contexts/venues/infrastructure/pmxt/pmxt-market-mapper";
import {
  mapPmxtOrderbookToMarketBook,
  PmxtMarketBook,
  PmxtSdkOrderBook,
} from "../src/contexts/venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import {
  canonicalizePmxtMarketSnapshot,
  canonicalizePmxtMarketBook,
  resolveOpportunityCalculatorOptions,
} from "../src/contexts/scanner/pmxt/pmxt-read-parity";
import { comparePmxtCoverage } from "../src/contexts/scanner/pmxt/pmxt-coverage-comparator";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface HarnessConfig {
  kalshiSeriesTicker: string;
  polymarketSeriesSlug: string;
  nativeOnly: boolean;
  pmxtVenue: "kalshi" | "polymarket" | "both";
  marketLimit: number | undefined;
  pmxtSource: "hosted" | "mock";
  pmxtApiKey: string;
  pmxtHostedBaseUrl: string;
  pmxtKalshiQuery: string;
  pmxtPolyQuery: string;
  pmxtSkipBooks: boolean;
}

function loadConfig(): HarnessConfig {
  const kalshiSeriesTicker = process.env.KALSHI_SERIES_TICKER ?? "KXBTCD";
  const polymarketSeriesSlug = process.env.POLYMARKET_SERIES_SLUG ?? "btc-multi-strikes-weekly";
  const nativeOnly = process.env.COMPARE_NATIVE_ONLY === "1";
  const pmxtVenueRaw = (process.env.COMPARE_PMXT_VENUE ?? "both").toLowerCase();
  const pmxtVenue =
    pmxtVenueRaw === "kalshi" || pmxtVenueRaw === "polymarket" ? pmxtVenueRaw : "both";
  const marketLimitRaw = process.env.COMPARE_MARKET_LIMIT;
  const marketLimit = marketLimitRaw ? Number(marketLimitRaw) : undefined;
  const pmxtSourceRaw = (process.env.COMPARE_PMXT_SOURCE ?? "hosted").toLowerCase();
  const pmxtSource = pmxtSourceRaw === "mock" ? "mock" : "hosted";
  return {
    kalshiSeriesTicker,
    polymarketSeriesSlug,
    nativeOnly,
    pmxtVenue,
    marketLimit: Number.isFinite(marketLimit) ? marketLimit : undefined,
    pmxtSource,
    pmxtApiKey: process.env.PMXT_API_KEY ?? "",
    // PMXT_HOSTED_BASE_URL is optional: the pmxtjs SDK auto-resolves the
    // hosted endpoint `https://api.pmxt.dev` whenever a PMXT_API_KEY is
    // present (see pmxtjs constants.js resolvePmxtBaseUrl). Default it here
    // so a key-only config works.
    pmxtHostedBaseUrl: process.env.PMXT_HOSTED_BASE_URL ?? "https://api.pmxt.dev",
    // Hosted fetchMarkets queries. The hosted global list returns
    // politics/sports, not crypto; a query is required to surface the same
    // series the native scan uses (KXBTCD). Defaults target BTC.
    pmxtKalshiQuery: process.env.COMPARE_PMXT_KALSHI_QUERY ?? "Bitcoin price",
    pmxtPolyQuery: process.env.COMPARE_PMXT_POLY_QUERY ?? "bitcoin",
    // The hosted API rate-limits aggressively; per-market orderbook fetches
    // (one HTTP call per market) exhaust the budget before both venues finish.
    // Skip PMXT books to focus the hosted run on coverage + candidate-pair
    // comparison (which only needs markets). Set COMPARE_PMXT_SKIP_BOOKS=0 to
    // fetch books (will likely 429 without a higher tier).
    pmxtSkipBooks: (process.env.COMPARE_PMXT_SKIP_BOOKS ?? "1") !== "0",
  };
}

// ---------------------------------------------------------------------------
// Pipeline (shared by both paths)
// ---------------------------------------------------------------------------

interface PipelineResult {
  normalized: NormalizedMarket[];
  pairs: CandidatePair[];
  decisions: EquivalenceDecision[];
  opportunities: CrossVenueOpportunity[];
}

function runPipeline(
  snapshots: VenueMarketSnapshot[],
  books: MarketBook[],
  calculator: OpportunityCalculator,
  options: Readonly<OpportunityCalculatorOptions>,
): PipelineResult {
  const normalizer = new MarketNormalizer();
  const pairGenerator = new CandidatePairGenerator();
  const equivalencePolicy = new DeterministicEquivalencePolicy();

  const normalized = snapshots.map((s) => normalizer.normalize(s));
  const pairs = pairGenerator.generate(normalized);
  const decisions = pairs.map((p) => equivalencePolicy.classify(p));

  const booksByKey = new Map(books.map((b) => [`${b.venue}:${b.marketId}`, b]));
  const opportunities: CrossVenueOpportunity[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const decision = decisions[i];
    if (decision.equivalenceClass !== "A") continue;
    const kalshiKey = `${pair.kalshiMarket.venue}:${pair.kalshiMarket.venueMarketId}`;
    const polyKey = `${pair.polymarketMarket.venue}:${pair.polymarketMarket.venueMarketId}`;
    const kalshiBook = booksByKey.get(kalshiKey);
    const polyBook = booksByKey.get(polyKey);
    if (!kalshiBook || !polyBook) continue;
    opportunities.push(...calculator.calculate(pair, decision, kalshiBook, polyBook, options));
  }

  return { normalized, pairs, decisions, opportunities };
}

// ---------------------------------------------------------------------------
// Pair key (stable across paths — uses native venue market IDs)
// ---------------------------------------------------------------------------

function pairKey(pair: CandidatePair): string {
  return `${pair.kalshiMarket.venueMarketId}|${pair.polymarketMarket.venueMarketId}`;
}

interface PairSummary {
  key: string;
  kalshiTitle: string;
  polymarketTitle: string;
  class: EquivalenceDecision["equivalenceClass"];
  reasons: string[];
  opportunities: number;
  bestNetEdge: number | undefined;
}

interface OpportunitySummary {
  count: number;
  bestNetEdge: number;
}

function summarizeOpportunities(
  opportunities: CrossVenueOpportunity[],
): Map<string, OpportunitySummary> {
  const byPair = new Map<string, OpportunitySummary>();
  for (const opportunity of opportunities) {
    const current = byPair.get(opportunity.pairId);
    byPair.set(opportunity.pairId, {
      count: (current?.count ?? 0) + 1,
      bestNetEdge: current === undefined
        ? opportunity.netEdge
        : Math.max(current.bestNetEdge, opportunity.netEdge),
    });
  }
  return byPair;
}

function summarizePairs(result: PipelineResult): Map<string, PairSummary> {
  const byKey = new Map<string, PairSummary>();
  const opportunitySummaryByPair = summarizeOpportunities(result.opportunities);

  for (let i = 0; i < result.pairs.length; i++) {
    const pair = result.pairs[i];
    const decision = result.decisions[i];
    const key = pairKey(pair);
    byKey.set(key, {
      key,
      kalshiTitle: pair.kalshiMarket.title,
      polymarketTitle: pair.polymarketMarket.title,
      class: decision.equivalenceClass,
      reasons: decision.reasons,
      opportunities: opportunitySummaryByPair.get(pair.id)?.count ?? 0,
      bestNetEdge: opportunitySummaryByPair.get(pair.id)?.bestNetEdge,
    });
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// Native path
// ---------------------------------------------------------------------------

interface NativeData {
  kalshiMarkets: VenueMarketSnapshot[];
  polymarketMarkets: VenueMarketSnapshot[];
  kalshiBooks: MarketBook[];
  polymarketBooks: MarketBook[];
}

async function fetchNative(config: HarnessConfig): Promise<NativeData> {
  const kalshiClient: VenueClient = new KalshiPublicVenueClient(
    "https://external-api.kalshi.com/trade-api/v2",
    { seriesTicker: config.kalshiSeriesTicker, marketLimit: config.marketLimit },
  );
  // PolymarketPublicVenueClient defaults to gamma-api for markets + clob for
  // books; only pass the series scoping + limit options.
  const polymarketClient: VenueClient = new PolymarketPublicVenueClient(
    undefined,
    undefined,
    { seriesSlug: config.polymarketSeriesSlug, marketLimit: config.marketLimit },
  );

  console.log(`[native] fetching Kalshi series=${config.kalshiSeriesTicker} and Polymarket series=${config.polymarketSeriesSlug} ...`);
  const [kalshiMarkets, polymarketMarkets] = await Promise.all([
    kalshiClient.listMarkets(),
    polymarketClient.listMarkets(),
  ]);
  console.log(`[native] kalshi markets=${kalshiMarkets.length} polymarket markets=${polymarketMarkets.length}`);

  const [kalshiBooks, polymarketBooks] = await Promise.all([
    kalshiClient.listOrderbooks(kalshiMarkets),
    polymarketClient.listOrderbooks(polymarketMarkets),
  ]);
  console.log(`[native] kalshi books=${kalshiBooks.length} polymarket books=${polymarketBooks.length}`);
  return { kalshiMarkets, polymarketMarkets, kalshiBooks, polymarketBooks };
}

// ---------------------------------------------------------------------------
// PMXT path
// ---------------------------------------------------------------------------

interface PmxtData {
  pmxtMarkets: PmxtMarketSnapshot[];
  pmxtBooks: PmxtMarketBook[];
}

async function fetchPmxt(config: HarnessConfig): Promise<PmxtData> {
  if (config.pmxtSource === "mock") {
    return fetchPmxtMock(config);
  }
  return fetchPmxtHosted(config);
}

// Local offline PMXT path. Uses the pmxtjs SDK against the local pmxt-core
// sidecar (auto-started by the SDK), so no hosted API key or URL is required.
// This exercises the real PMXT SDK, the PMXT mappers, and the shared domain
// pipeline end-to-end — the PMXT scanner is genuinely run.
//
// The local SDK returns markets in the unified PMXT schema with `marketId`
// (not `id`), `outcomeId` (not `id`), and venue-native outcome labels (Kalshi:
// "Above 300K"/"Not Above 300K"; Mock: "Yes"/"No"). The production PMXT
// market mapper expects `id` + literal yes/no labels + sourceExchange. To
// reuse the real mapper and pipeline unchanged, we adapt the unified record
// to the `PmxtMarket` shape the mapper expects: map `marketId`→`id`,
// `outcomeId`→outcome `id`, normalize outcome labels to Yes/No (the
// affirmative side is YES, the negated/"Not X" side is NO), and stamp
// `sourceExchange` from the exchange we queried.
async function fetchPmxtMock(config: HarnessConfig): Promise<PmxtData> {
  const pmxtjs = require("pmxtjs");

  // Which local exchanges to query. Default "kalshi,polymarket" so the PMXT
  // side can form cross-venue candidate pairs just like the native side.
  // Use COMPARE_PMXT_MOCK_VENUE=mock for the synthetic offline Mock only.
  const mockVenue = (process.env.COMPARE_PMXT_MOCK_VENUE ?? "kalshi,polymarket").toLowerCase();
  const venues = mockVenue.split(",").map((v) => v.trim()).filter(Boolean);
  const polyQuery = process.env.COMPARE_PMXT_POLY_QUERY ?? "bitcoin";

  console.log(`[pmxt:local] starting local pmxt-core sidecar (venues: ${venues.join(", ")}) ...`);
  const capturedAt = new Date().toISOString();
  const pmxtMarkets: PmxtMarketSnapshot[] = [];
  const pmxtBooks: PmxtMarketBook[] = [];
  let skippedNonBinary = 0;
  let skippedAmbiguous = 0;

  for (const venue of venues) {
    const ExchangeCtor = venue === "mock" ? pmxtjs.Mock : venue === "kalshi" ? pmxtjs.Kalshi : venue === "polymarket" ? pmxtjs.Polymarket : null;
    if (!ExchangeCtor) { console.log(`[pmxt:local] unknown venue "${venue}", skipping`); continue; }
    const stampedSourceExchange = venue === "mock" ? "mock" : venue;
    const exchange = new ExchangeCtor({ autoStartServer: true });
    // Polymarket's local endpoint requires a query/limit; Kalshi/Mock return
    // a global list. Use a crypto query for Polymarket to maximize overlap
    // with the native crypto scan scope.
    const fetchArgs = venue === "polymarket" ? { query: polyQuery, limit: 100 } : undefined;
    const rawMarkets = (await exchange.fetchMarkets(fetchArgs)) as UnifiedPmxtMarket[];
    console.log(`[pmxt:local] ${venue} raw markets=${rawMarkets.length}`);

    const admitted = admitPmxtMarkets(rawMarkets, stampedSourceExchange, capturedAt);
    pmxtMarkets.push(...admitted.markets);
    skippedNonBinary += admitted.skippedNonBinary;
    skippedAmbiguous += admitted.skippedAmbiguous;
    pmxtBooks.push(...await fetchPmxtBooks(admitted.markets, exchange, capturedAt));
  }
  console.log(`[pmxt:local] admitted markets=${pmxtMarkets.length} books=${pmxtBooks.length} skippedNonBinary=${skippedNonBinary} skippedAmbiguous=${skippedAmbiguous}`);
  return { pmxtMarkets, pmxtBooks };
}

// Adapt a unified-schema PMXT market (hosted catalog or local sidecar) to the
// `PmxtMarket` shape the production mapper expects. Returns undefined for
// non-binary or orientation-ambiguous markets.
//
// Two shape gaps the production mapper does not handle:
//   1. Outcomes carry venue-native labels (Kalshi: "Miami"/"Not Miami") and
//      `outcomeId`, not literal Yes/No — the mapper rejects these. We
//      normalize orientation to Yes/No using, in order: explicit yes/no
//      labels, a "-NO"/"-no" outcomeId suffix (Kalshi convention), or a
//      "Not X"/"No X" label heuristic.
//   2. `sourceExchange` is often null on the hosted catalog and the native
//      venue ticker lives in `slug` (Kalshi) rather than `id` (a UUID). We
//      stamp `sourceExchange` from the queried venue and use `slug` as the
//      `venueMarketId` provenance so coverage comparison keys on the native
//      ticker the native scanner uses.
interface UnifiedPmxtOutcome {
  id?: string;
  outcomeId?: string;
  label?: string;
}

interface UnifiedPmxtMarket {
  id?: string;
  marketId?: string;
  slug?: string;
  title?: string;
  description?: string;
  outcomes?: UnifiedPmxtOutcome[];
}

interface PmxtMarketAdmission {
  markets: PmxtMarketSnapshot[];
  skippedNonBinary: number;
  skippedAmbiguous: number;
}

interface PmxtExchangeLike {
  fetchOrderBooks(
    outcomeIds: Array<{ outcomeId: string }>,
  ): Promise<Record<string, PmxtSdkOrderBook>>;
}

function admitPmxtMarkets(
  rawMarkets: UnifiedPmxtMarket[],
  sourceExchange: string,
  capturedAt: string,
): PmxtMarketAdmission {
  const markets: PmxtMarketSnapshot[] = [];
  let skippedNonBinary = 0;
  let skippedAmbiguous = 0;

  for (const raw of rawMarkets) {
    const adapted = adaptUnifiedPmxtMarket(raw, sourceExchange);
    if (!adapted) {
      skippedNonBinary += 1;
      continue;
    }
    try {
      markets.push(mapPmxtMarketToSnapshot(adapted, capturedAt));
    } catch {
      skippedAmbiguous += 1;
    }
  }

  return { markets, skippedNonBinary, skippedAmbiguous };
}

async function fetchPmxtBooks(
  markets: PmxtMarketSnapshot[],
  exchange: PmxtExchangeLike,
  capturedAt: string,
): Promise<PmxtMarketBook[]> {
  const books: PmxtMarketBook[] = [];
  for (const market of markets) {
    const yesId = typeof market.rawPayload.yesOutcomeId === "string"
      ? market.rawPayload.yesOutcomeId
      : undefined;
    const noId = typeof market.rawPayload.noOutcomeId === "string"
      ? market.rawPayload.noOutcomeId
      : undefined;
    if (!yesId || !noId) continue;

    try {
      const rawBooks = await exchange.fetchOrderBooks([
        { outcomeId: yesId },
        { outcomeId: noId },
      ]);
      const yesRaw = rawBooks[yesId];
      const noRaw = rawBooks[noId];
      if (!yesRaw || !noRaw) continue;
      books.push(
        mapPmxtOrderbookToMarketBook(
          market.venueMarketId,
          yesRaw,
          noRaw,
          capturedAt,
        ),
      );
    } catch {
      // Book-fetch failures are non-fatal in the comparison harness.
    }
  }
  return books;
}

function adaptUnifiedPmxtMarket(
  raw: UnifiedPmxtMarket,
  sourceExchange: string,
): PmxtMarket | undefined {
  const id = raw.id ?? raw.marketId;
  if (!id || typeof id !== "string") return undefined;
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  if (outcomes.length !== 2) return undefined;
  const labels = outcomes.map((outcome) =>
    typeof outcome.label === "string" ? outcome.label.toLowerCase() : "",
  );
  const outcomeIds = outcomes.map((outcome) => {
    const outcomeId = outcome.outcomeId ?? outcome.id;
    return typeof outcomeId === "string" ? outcomeId : "";
  });

  // Orientation: explicit yes/no labels first.
  let yesIdx = labels.findIndex((l: string) => l === "yes");
  let noIdx = labels.findIndex((l: string) => l === "no");
  // Kalshi convention: the NO outcome id ends in "-NO" (e.g. KX...-MIA-NO).
  if (yesIdx === -1 || noIdx === -1) {
    const noById = outcomeIds.findIndex((oid: string) => /-no$/i.test(oid));
    if (noById !== -1) {
      noIdx = noById;
      yesIdx = noById === 0 ? 1 : 0;
    }
  }
  // Label heuristic: exactly one "Not X" / "No X" side → that's NO.
  if (yesIdx === -1 || noIdx === -1) {
    const neg = labels.map((l: string) => /^(not |no )/.test(l));
    if (neg.filter(Boolean).length === 1) {
      noIdx = neg.indexOf(true);
      yesIdx = neg.indexOf(false);
    }
  }
  if (yesIdx === -1 || noIdx === -1 || yesIdx === noIdx) return undefined;

  // Native venue ticker: prefer `slug` (Kalshi exposes the market ticker
  // here); fall back to the catalog id. This is the key the native scanner
  // and coverage comparator use, so it must be the venue-native ID.
  const venueMarketId = typeof raw.slug === "string" && raw.slug.trim().length > 0 ? raw.slug.trim() : id;
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : id,
    description: typeof raw.description === "string" ? raw.description : "",
    sourceExchange,
    venueMarketId,
    outcomes: [
      { id: outcomeIds[yesIdx], label: "Yes" },
      { id: outcomeIds[noIdx], label: "No" },
    ],
  };
}

async function fetchPmxtHosted(config: HarnessConfig): Promise<PmxtData> {
  if (!config.pmxtApiKey) {
    throw new Error("PMXT_API_KEY is required for the PMXT hosted side (set COMPARE_PMXT_SOURCE=mock to run offline without a key)");
  }

  // Instantiate the pmxtjs exchange directly with the hosted key. The SDK
  // auto-resolves the hosted base URL `https://api.pmxt.dev` from the key
  // (pmxtjs constants.js resolvePmxtBaseUrl), and autoStartServer:false keeps
  // it from spawning a local sidecar. We bypass our createPmxtHostedClient
  // factory because its fetchMarkets() wrapper drops the { query } argument,
  // and a query is required to surface the KXBTCD series the native scan uses.
  const pmxtjs = require("pmxtjs");
  const venues: ("kalshi" | "polymarket")[] =
    config.pmxtVenue === "both" ? ["kalshi", "polymarket"] : [config.pmxtVenue];
  const capturedAt = new Date().toISOString();
  const allMarkets: PmxtMarketSnapshot[] = [];
  const allBooks: PmxtMarketBook[] = [];
  let skippedNonBinary = 0;
  let skippedAmbiguous = 0;

  for (const venue of venues) {
    console.log(`[pmxt] fetching hosted ${venue} markets ...`);
    const ExchangeCtor = venue === "kalshi" ? pmxtjs.Kalshi : pmxtjs.Polymarket;
    const exchange = new ExchangeCtor({
      pmxtApiKey: config.pmxtApiKey,
      baseUrl: config.pmxtHostedBaseUrl,
      autoStartServer: false,
    });
    // The hosted catalog's global list returns politics/sports, not crypto;
    // a query is required to surface the same series the native scan uses
    // (KXBTCD). The hosted catalog also returns venue-native outcome labels
    // (Kalshi: "$66,000 or above"/"Not $66,000 or above") and sourceExchange
    // often null, which the production market mapper rejects ("outcome
    // identity is ambiguous"). Adapt each raw market to the `PmxtMarket`
    // shape (yes/no orientation, stamped sourceExchange, venueMarketId from
    // slug) before mapping — same adapter the local path uses. Harness-only;
    // production mappers are unchanged.
    const query = venue === "kalshi" ? config.pmxtKalshiQuery : config.pmxtPolyQuery;
    // Keep the hosted fetch limit small: the SDK paginates large limits into
    // many paged calls, which the hosted API rate-limits (429) before the
    // second venue finishes. 20 is comfortably under the observed ceiling.
    const rawMarkets = (await exchange.fetchMarkets({ query, limit: 20 })) as UnifiedPmxtMarket[];
    console.log(`[pmxt] ${venue} raw markets=${rawMarkets.length} (query=${JSON.stringify(query)})`);
    const admitted = admitPmxtMarkets(rawMarkets, venue, capturedAt);
    allMarkets.push(...admitted.markets);
    skippedNonBinary += admitted.skippedNonBinary;
    skippedAmbiguous += admitted.skippedAmbiguous;

    // Skippable: the hosted API rate-limits aggressively and per-market book
    // fetches exhaust the budget before both venues finish. Coverage + pair
    // comparison only needs markets.
    if (!config.pmxtSkipBooks) {
      allBooks.push(...await fetchPmxtBooks(admitted.markets, exchange, capturedAt));
    } else {
      console.log(`[pmxt] ${venue} skipping books (COMPARE_PMXT_SKIP_BOOKS=1)`);
    }
    console.log(`[pmxt] ${venue} admitted=${admitted.markets.length} books=${allBooks.length}`);
  }
  console.log(`[pmxt:hosted] total admitted markets=${allMarkets.length} books=${allBooks.length} skippedNonBinary=${skippedNonBinary} skippedAmbiguous=${skippedAmbiguous}`);
  return { pmxtMarkets: allMarkets, pmxtBooks: allBooks };
}

function canonicalizePmxtData(pmxt: PmxtData): { snapshots: VenueMarketSnapshot[]; books: MarketBook[] } {
  const snapshots: VenueMarketSnapshot[] = [];
  const books: MarketBook[] = [];
  const marketByCatalogId = new Map(pmxt.pmxtMarkets.map((m) => [m.venueMarketId, m]));
  for (const m of pmxt.pmxtMarkets) {
    try {
      snapshots.push(canonicalizePmxtMarketSnapshot(m));
    } catch (err) {
      console.warn(`[pmxt] skip market ${m.venueMarketId}: ${(err as Error).message}`);
    }
  }
  for (const b of pmxt.pmxtBooks) {
    const market = marketByCatalogId.get(b.marketId);
    if (!market) continue;
    try {
      books.push(canonicalizePmxtMarketBook(market, b));
    } catch (err) {
      console.warn(`[pmxt] skip book ${b.marketId}: ${(err as Error).message}`);
    }
  }
  return { snapshots, books };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

interface DiffReport {
  native: PipelineResult;
  pmxt: PipelineResult;
  pairDiff: {
    shared: string[];
    nativeOnly: PairSummary[];
    pmxtOnly: PairSummary[];
    classMismatches: Array<{ key: string; native: string; pmxt: string; reasonsNative: string[]; reasonsPmxt: string[] }>;
  };
  opportunityDiff: {
    nativeCount: number;
    pmxtCount: number;
    sharedCount: number;
    nativeOnlyCount: number;
    pmxtOnlyCount: number;
    edgeMismatches: Array<{ pairId: string; nativeEdge: number | undefined; pmxtEdge: number | undefined }>;
  };
}

function diffResults(native: PipelineResult, pmxt: PipelineResult): DiffReport {
  const nativeByPair = summarizePairs(native);
  const pmxtByPair = summarizePairs(pmxt);

  const shared: string[] = [];
  const nativeOnly: PairSummary[] = [];
  const pmxtOnly: PairSummary[] = [];
  const classMismatches: DiffReport["pairDiff"]["classMismatches"] = [];

  for (const [key, nativeSummary] of nativeByPair) {
    if (pmxtByPair.has(key)) {
      shared.push(key);
      const pmxtSummary = pmxtByPair.get(key)!;
      if (nativeSummary.class !== pmxtSummary.class) {
        classMismatches.push({
          key,
          native: nativeSummary.class,
          pmxt: pmxtSummary.class,
          reasonsNative: nativeSummary.reasons,
          reasonsPmxt: pmxtSummary.reasons,
        });
      }
    } else {
      nativeOnly.push(nativeSummary);
    }
  }
  for (const [key, pmxtSummary] of pmxtByPair) {
    if (!nativeByPair.has(key)) pmxtOnly.push(pmxtSummary);
  }

  const nativeOppByPair = summarizeOpportunities(native.opportunities);
  const pmxtOppByPair = summarizeOpportunities(pmxt.opportunities);
  let sharedCount = 0;
  const edgeMismatches: DiffReport["opportunityDiff"]["edgeMismatches"] = [];
  for (const [pairId, nativeOpportunity] of nativeOppByPair) {
    const pmxtOpportunity = pmxtOppByPair.get(pairId);
    if (!pmxtOpportunity) continue;

    sharedCount += 1;
    if (Math.abs(nativeOpportunity.bestNetEdge - pmxtOpportunity.bestNetEdge) > 0.0001) {
      edgeMismatches.push({
        pairId,
        nativeEdge: nativeOpportunity.bestNetEdge,
        pmxtEdge: pmxtOpportunity.bestNetEdge,
      });
    }
  }

  return {
    native,
    pmxt,
    pairDiff: { shared, nativeOnly, pmxtOnly, classMismatches },
    opportunityDiff: {
      nativeCount: native.opportunities.length,
      pmxtCount: pmxt.opportunities.length,
      sharedCount,
      nativeOnlyCount: Math.max(0, native.opportunities.length - sharedCount),
      pmxtOnlyCount: Math.max(0, pmxt.opportunities.length - sharedCount),
      edgeMismatches,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReport(
  report: DiffReport,
  coverage: ReturnType<typeof comparePmxtCoverage> | undefined,
): string {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push("PMXT vs NATIVE opportunity-scanner comparison");
  lines.push("=".repeat(78));

  lines.push("");
  lines.push("Coverage (PMXT vs native, by venue-native ID):");
  if (coverage) {
    for (const venue of ["kalshi", "polymarket"] as const) {
      const r = coverage[venue];
      lines.push(
        `  ${venue}: native=${r.authoritativeCount} pmxtMapped=${r.pmxtMappedCount} overlap=${r.overlapCount} ` +
          `nativeOnly=${r.authoritativeOnlyIds.length} pmxtOnly=${r.pmxtOnlyIds.length} ` +
          `mappingFailures=${coverage.mappingFailures.length} statusDisagreements=${r.statusDisagreements.length} missingResolutionText=${r.missingResolutionText.length}`,
      );
    }
  } else {
    lines.push("  (PMXT side not run — no coverage comparison)");
  }

  lines.push("");
  lines.push("Pipeline totals:");
  lines.push(`  native:  normalized=${report.native.normalized.length} pairs=${report.native.pairs.length} opportunities=${report.native.opportunities.length}`);
  lines.push(`  pmxt:    normalized=${report.pmxt.normalized.length} pairs=${report.pmxt.pairs.length} opportunities=${report.pmxt.opportunities.length}`);

  lines.push("");
  lines.push("Candidate-pair diff (key = kalshiVenueMarketId|polymarketVenueMarketId):");
  lines.push(`  shared pairs:          ${report.pairDiff.shared.length}`);
  lines.push(`  native-only pairs:     ${report.pairDiff.nativeOnly.length}`);
  lines.push(`  pmxt-only pairs:       ${report.pairDiff.pmxtOnly.length}`);
  lines.push(`  equivalence-class mismatches: ${report.pairDiff.classMismatches.length}`);

  if (report.pairDiff.nativeOnly.length > 0) {
    lines.push("");
    lines.push("  -- native-only pairs (native matched, PMXT path did not) --");
    for (const s of report.pairDiff.nativeOnly.slice(0, 20)) {
      lines.push(`    [${s.class}] ${s.kalshiTitle}  <>  ${s.polymarketTitle}`);
      lines.push(`        reasons: ${s.reasons.join(", ")}`);
    }
    if (report.pairDiff.nativeOnly.length > 20) {
      lines.push(`    ... and ${report.pairDiff.nativeOnly.length - 20} more`);
    }
  }

  if (report.pairDiff.pmxtOnly.length > 0) {
    lines.push("");
    lines.push("  -- pmxt-only pairs (PMXT path matched, native did not) --");
    for (const s of report.pairDiff.pmxtOnly.slice(0, 20)) {
      lines.push(`    [${s.class}] ${s.kalshiTitle}  <>  ${s.polymarketTitle}`);
      lines.push(`        reasons: ${s.reasons.join(", ")}`);
    }
    if (report.pairDiff.pmxtOnly.length > 20) {
      lines.push(`    ... and ${report.pairDiff.pmxtOnly.length - 20} more`);
    }
  }

  if (report.pairDiff.classMismatches.length > 0) {
    lines.push("");
    lines.push("  -- equivalence-class mismatches on shared pairs --");
    for (const m of report.pairDiff.classMismatches.slice(0, 20)) {
      lines.push(`    ${m.key}: native=${m.native} pmxt=${m.pmxt}`);
      lines.push(`        native reasons: ${m.reasonsNative.join(", ")}`);
      lines.push(`        pmxt   reasons: ${m.reasonsPmxt.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Opportunity diff:");
  lines.push(`  native opportunities: ${report.opportunityDiff.nativeCount}`);
  lines.push(`  pmxt   opportunities: ${report.opportunityDiff.pmxtCount}`);
  lines.push(`  shared (by pairId):   ${report.opportunityDiff.sharedCount}`);
  lines.push(`  native-only opps:     ${report.opportunityDiff.nativeOnlyCount}`);
  lines.push(`  pmxt-only opps:       ${report.opportunityDiff.pmxtOnlyCount}`);
  lines.push(`  net-edge mismatches on shared: ${report.opportunityDiff.edgeMismatches.length}`);
  for (const e of report.opportunityDiff.edgeMismatches.slice(0, 20)) {
    lines.push(`    ${e.pairId}: native=${e.nativeEdge?.toFixed(4)} pmxt=${e.pmxtEdge?.toFixed(4)}`);
  }

  lines.push("");
  lines.push("=".repeat(78));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  console.log(`[harness] config: nativeOnly=${config.nativeOnly} pmxtSource=${config.pmxtSource} pmxtVenue=${config.pmxtVenue} marketLimit=${config.marketLimit ?? "none"}`);

  const calculator = new OpportunityCalculator();
  const options = resolveOpportunityCalculatorOptions({
    now: new Date().toISOString(),
    maxBookAgeMs: 5 * 60 * 1000, // tolerate PMXT vs native fetch skew
  });

  // --- Native ---
  const nativeData = await fetchNative(config);
  const nativeSnapshots = [...nativeData.kalshiMarkets, ...nativeData.polymarketMarkets];
  const nativeBooks = [...nativeData.kalshiBooks, ...nativeData.polymarketBooks];
  const native = runPipeline(nativeSnapshots, nativeBooks, calculator, options);
  console.log(`[native] pipeline: normalized=${native.normalized.length} pairs=${native.pairs.length} opportunities=${native.opportunities.length}`);

  if (config.nativeOnly) {
    const report = diffResults(native, { normalized: [], pairs: [], decisions: [], opportunities: [] });
    console.log(renderReport(report, undefined));
    return;
  }

  // --- PMXT ---
  let pmxt: PipelineResult = { normalized: [], pairs: [], decisions: [], opportunities: [] };
  let coverage: ReturnType<typeof comparePmxtCoverage> | undefined;
  try {
    const pmxtData = await fetchPmxt(config);
    const canonical = canonicalizePmxtData(pmxtData);
    console.log(`[pmxt] canonicalized: snapshots=${canonical.snapshots.length} books=${canonical.books.length}`);
    pmxt = runPipeline(canonical.snapshots, canonical.books, calculator, options);
    console.log(`[pmxt] pipeline: normalized=${pmxt.normalized.length} pairs=${pmxt.pairs.length} opportunities=${pmxt.opportunities.length}`);

    coverage = comparePmxtCoverage({
      pmxtMarkets: pmxtData.pmxtMarkets,
      authoritativeKalshiMarkets: nativeData.kalshiMarkets,
      authoritativePolymarketMarkets: nativeData.polymarketMarkets,
    });
  } catch (err) {
    console.error(`[pmxt] FAILED: ${(err as Error).message}`);
    console.error("[pmxt] continuing with native-only report.");
  }

  const report = diffResults(native, pmxt);
  console.log(renderReport(report, coverage));
}

main().catch((err) => {
  console.error("[harness] fatal:", err);
  process.exit(1);
});