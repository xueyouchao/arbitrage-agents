import { describe, expect, it, vi } from "vitest";
import { PostgresPmxtAuthoritativeMarketSnapshotRepository } from "../../src/contexts/scanner/pmxt/postgres-pmxt-authoritative-market-snapshot-repository";

describe("PostgresPmxtAuthoritativeMarketSnapshotRepository", () => {
  it("reads only the claimed scan and unwraps the scanner payload envelope", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          venue: "kalshi",
          venue_market_id: "KXBTC-26JUL",
          raw_payload: {
            scannerTitle: "Will BTC exceed $100k?",
            scannerRawResolutionText: "Resolves Yes above $100,000.",
            sourcePayload: { ticker: "KXBTC-26JUL", yes_bid: 42 }
          },
          captured_at: new Date("2026-07-15T10:00:00.000Z")
        }
      ]
    });
    const repository = new PostgresPmxtAuthoritativeMarketSnapshotRepository({ query } as never);

    const snapshots = await repository.listByScanRunId(
      "00000000-0000-4000-8000-000000000010"
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("where scan_run_id = $1"),
      ["00000000-0000-4000-8000-000000000010"]
    );
    expect(snapshots).toEqual([
      {
        venue: "kalshi",
        venueMarketId: "KXBTC-26JUL",
        title: "Will BTC exceed $100k?",
        rawResolutionText: "Resolves Yes above $100,000.",
        rawPayload: { ticker: "KXBTC-26JUL", yes_bid: 42 },
        capturedAt: "2026-07-15T10:00:00.000Z"
      }
    ]);
  });

  it("rejects malformed scanner payload envelopes", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          venue: "polymarket",
          venue_market_id: "market-1",
          raw_payload: { title: "legacy payload without scanner envelope" },
          captured_at: new Date("2026-07-15T10:00:00.000Z")
        }
      ]
    });
    const repository = new PostgresPmxtAuthoritativeMarketSnapshotRepository({ query } as never);

    await expect(repository.listByScanRunId("scan-1")).rejects.toThrow(
      "invalid authoritative market snapshot envelope"
    );
  });
});
