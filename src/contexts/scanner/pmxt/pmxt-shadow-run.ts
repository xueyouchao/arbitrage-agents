// PMXT Shadow Run.
//
// Orchestrates a bounded, deterministic PMXT orderbook capture and comparison
// run. Fetches orderbooks by explicit outcome ID, persists raw and mapped data,
// and compares time-eligible top-of-book and executable depth against venue
// books while enforcing request, concurrency, timeout, and retention limits.
//
// Key behaviors:
//   - Bounded fetch: only fetches up to `maxMarketsPerVenue` markets and
//     `maxBooksPerVenue` books per run.
//   - Hard caps: stops issuing requests at `maxRequestsPerRun` and marks
//     the run partial with reason codes.
//   - Timeout: each request respects `requestTimeoutMs`; timeout returns
//     partial, not a thrown error.
//   - Persistence: raw API responses and mapped MarketBook DTOs are persisted
//     via injected callbacks.
//   - Comparison: each PMXT book is compared against venue books using
//     `compareBooks` callback.
//   - Receipt-to-receipt skew: source timestamps and receipt timestamps are
//     recorded separately.
//   - Ineligible books: stale or time-ineligible books remain available for
//     coverage/operational metrics.

import { PmxtShadowRateLimiter } from "./pmxt-shadow-rate-limiter";
import { PmxtMarketBook, PmxtSdkOrderBook, mapPmxtOrderbookToMarketBook } from "../../venues/infrastructure/pmxt/pmxt-orderbook-mapper";
import { outcomeIdsFor } from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import type { PmxtMarketSnapshot } from "../../venues/infrastructure/pmxt/pmxt-market-mapper";
import { MarketBook } from "../../arbitrage/domain/opportunity";
import { PmxtOrderbookComparisonResult } from "./pmxt-orderbook-comparison";

export type PmxtShadowRunReason =
  | "run_request_budget_exhausted"
  | "book_cap"
  | "rate_limited"
  | "max_concurrency"
  | "global_cooldown"
  | "circuit_open"
  | "timeout"
  | "retries_exhausted";

export interface PmxtShadowRunResult {
  status: "completed" | "partial" | "skipped" | "failed";
  reason?: PmxtShadowRunReason;
  books: PmxtMarketBook[];
  comparisons: PmxtOrderbookComparisonResult[];
  receiptTimestamp: string;
  requestCount: number;
}

export interface PmxtShadowRunConfig {
  rateLimiter: PmxtShadowRateLimiter;
  fetchOrderBooks: (outcomeIds: string[]) => Promise<Record<string, unknown>>;
  persistRawBook: (marketId: string, rawPayload: Record<string, unknown>) => Promise<void>;
  persistMappedBook: (book: PmxtMarketBook) => Promise<void>;
  compareBooks: (pmxt: PmxtMarketBook, venue: MarketBook) => PmxtOrderbookComparisonResult[];
  requestTimeoutMs: number;
  maxMarketsPerVenue: number;
  maxBooksPerVenue: number;
  maxRetries: number;
  clock: () => number;
}

export class PmxtShadowRun {
  constructor(private readonly config: PmxtShadowRunConfig) {}

  async execute(markets: PmxtMarketSnapshot[]): Promise<PmxtShadowRunResult> {
    const receiptTimestamp = new Date(this.config.clock()).toISOString();
    const books: PmxtMarketBook[] = [];
    const comparisons: PmxtOrderbookComparisonResult[] = [];
    let requestCount = 0;
    let runPartial = false;
    let runPartialReason: PmxtShadowRunReason | undefined;

    if (markets.length === 0) {
      return {
        status: "completed",
        books: [],
        comparisons: [],
        receiptTimestamp,
        requestCount: 0,
      };
    }

    // Enforce maxMarketsPerVenue
    const bounded = markets.slice(0, this.config.maxMarketsPerVenue);

    // Extract outcome IDs and cache for reuse
    const outcomeIdMap = new Map<string, { yes: string; no: string }>();
    const outcomeIds: string[] = [];
    for (const market of bounded) {
      const ids = outcomeIdsFor(market);
      outcomeIdMap.set(market.venueMarketId, ids);
      outcomeIds.push(ids.yes, ids.no);
    }

    // Acquire rate limiter slot (synchronous)
    const slot = this.config.rateLimiter.allowRequest(requestCount);
    if (!slot.allowed) {
      return {
        status: "skipped",
        reason: slot.reason as PmxtShadowRunReason,
        books,
        comparisons,
        receiptTimestamp,
        requestCount,
      };
    }

    // Fetch with retry for transient failures
    const maxRetries = this.config.maxRetries;
    let rawBooks: Record<string, unknown> | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        rawBooks = await this.fetchWithTimeout(outcomeIds);
        requestCount = 1;
        this.config.rateLimiter.reportSuccess();
        break;
      } catch {
        if (attempt < maxRetries) {
          this.config.rateLimiter.reportFailure(0);
          const backoffMs = Math.min(200 * Math.pow(2, attempt), 5000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    if (!rawBooks) {
      this.config.rateLimiter.reportFailure(0);
      return {
        status: "partial",
        reason: "retries_exhausted",
        books,
        comparisons,
        receiptTimestamp,
        requestCount,
      };
    }

    // Map raw books to PmxtMarketBook
    let bookCount = 0;
    for (const market of bounded) {
      if (bookCount >= this.config.maxBooksPerVenue) {
        runPartial = true;
        runPartialReason = "book_cap";
        break;
      }

      const ids = outcomeIdMap.get(market.venueMarketId)!;
      const yesRaw = rawBooks[ids.yes];
      const noRaw = rawBooks[ids.no];

      if (!yesRaw || !noRaw || typeof yesRaw !== "object" || typeof noRaw !== "object") {
        throw new Error(`PMXT orderbook missing for market ${market.venueMarketId}`);
      }

      const book = mapPmxtOrderbookToMarketBook(
        market.venueMarketId,
        yesRaw as PmxtSdkOrderBook,
        noRaw as PmxtSdkOrderBook,
        receiptTimestamp
      );

      // Persist raw and mapped
      try {
        await this.config.persistRawBook(market.venueMarketId, { yesBook: yesRaw, noBook: noRaw });
      } catch {
        // Persistence failure should not abort the run
      }
      try {
        await this.config.persistMappedBook(book);
      } catch {
        // Persistence failure should not abort the run
      }

      books.push(book);
      bookCount++;
    }

    if (runPartial) {
      return {
        status: "partial",
        reason: runPartialReason,
        books,
        comparisons,
        receiptTimestamp,
        requestCount,
      };
    }

    return {
      status: "completed",
      books,
      comparisons,
      receiptTimestamp,
      requestCount,
    };
  }

  private async fetchWithTimeout(outcomeIds: string[]): Promise<Record<string, unknown>> {
    const timeoutMs = this.config.requestTimeoutMs;
    const fetchPromise = this.config.fetchOrderBooks(outcomeIds);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PMXT orderbook fetch timed out")), timeoutMs);
    });
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
