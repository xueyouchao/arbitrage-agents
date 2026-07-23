import { Pool } from "pg";
import { Inject, Injectable } from "@nestjs/common";
import { DATABASE_POOL } from "../../shared/database/database-tokens";
import { VENUES, Venue } from "../../matching/domain/normalized-market";
import { VenueMarketSnapshot } from "../../venues/domain/venue-market";
import { PmxtAuthoritativeMarketSnapshotRepository } from "./pmxt-authoritative-market-snapshot-repository";

interface SnapshotRow {
  venue: string;
  venue_market_id: string;
  raw_payload: unknown;
  captured_at: Date;
}

interface SnapshotEnvelope {
  scannerTitle: string;
  scannerRawResolutionText: string;
  sourcePayload: Record<string, unknown>;
}

@Injectable()
export class PostgresPmxtAuthoritativeMarketSnapshotRepository
  implements PmxtAuthoritativeMarketSnapshotRepository
{
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async listByScanRunId(scanRunId: string): Promise<readonly VenueMarketSnapshot[]> {
    const result = await this.pool.query<SnapshotRow>(
      `select venue, venue_market_id, raw_payload, captured_at
       from venue_market_snapshots
       where scan_run_id = $1
       order by venue asc, venue_market_id asc, captured_at asc, id asc`,
      [scanRunId]
    );

    return result.rows.map((row) => {
      const envelope = parseEnvelope(row.raw_payload);
      return {
        venue: parseVenue(row.venue),
        venueMarketId: row.venue_market_id,
        title: envelope.scannerTitle,
        rawResolutionText: envelope.scannerRawResolutionText,
        rawPayload: envelope.sourcePayload,
        capturedAt: row.captured_at.toISOString()
      };
    });
  }
}

function parseEnvelope(value: unknown): SnapshotEnvelope {
  if (!isRecord(value)) {
    throw new Error("invalid authoritative market snapshot envelope");
  }

  const { scannerTitle, scannerRawResolutionText, sourcePayload } = value;
  if (
    typeof scannerTitle !== "string" ||
    typeof scannerRawResolutionText !== "string" ||
    !isRecord(sourcePayload)
  ) {
    throw new Error("invalid authoritative market snapshot envelope");
  }

  return { scannerTitle, scannerRawResolutionText, sourcePayload };
}

function parseVenue(value: string): Venue {
  if (!(VENUES as readonly string[]).includes(value)) {
    throw new Error(`unsupported authoritative venue: ${value}`);
  }
  return value as Venue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
