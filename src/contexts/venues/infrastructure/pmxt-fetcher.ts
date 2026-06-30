/**
 * Infrastructure adapter that calls the pmxt Python fetcher script
 * and returns structured, typed market data from both Polymarket and
 * Kalshi.
 *
 * Keeps the pmxt Python dependency isolated behind a subprocess call,
 * so the rest of the application never needs to know about Python or
 * pmxt internals.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { MarketBook } from "../../arbitrage/domain/opportunity";
import { VenueMarketSnapshot } from "../domain/venue-market";

const execFileAsync = promisify(execFile);

// Paths resolved relative to process.cwd() which is the project root
// when invoked from the runbook or NestJS application.
const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "fetch-pmxt-markets.py");
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv-pmxt", "bin", "python3");

export interface PmxtFetchResult {
  capturedAt: string;
  kalshiMarkets: VenueMarketSnapshot[];
  polymarketMarkets: VenueMarketSnapshot[];
  kalshiBooks: MarketBook[];
  polymarketBooks: MarketBook[];
}

export interface PmxtFetcherOptions {
  /** Timeout for the subprocess in ms. Default: 30_000. */
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<PmxtFetcherOptions> = {
  timeoutMs: 30_000,
};

/**
 * Fetcher that runs the pmxt Python script as a subprocess and parses
 * the resulting JSON into typed market data structures.
 */
export class PmxtFetcher {
  private readonly options: Required<PmxtFetcherOptions>;

  constructor(options: PmxtFetcherOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async fetch(): Promise<PmxtFetchResult> {
    const { stdout, stderr } = await execFileAsync(
      VENV_PYTHON,
      [SCRIPT_PATH],
      { timeout: this.options.timeoutMs, maxBuffer: 10 * 1024 * 1024 }
    );

    if (stderr) {
      // pmxt may log warnings to stderr — surface them but don't fail.
      console.error("[pmxt-fetcher] stderr:", stderr);
    }

    const raw = JSON.parse(stdout);

    if (raw.error) {
      throw new Error(`PmxtFetcher: ${raw.error}`);
    }

    return {
      capturedAt: raw.capturedAt,
      kalshiMarkets: raw.kalshiMarkets ?? [],
      polymarketMarkets: raw.polymarketMarkets ?? [],
      kalshiBooks: raw.kalshiBooks ?? [],
      polymarketBooks: raw.polymarketBooks ?? [],
    };
  }
}
