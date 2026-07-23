import { VenueMarketSnapshot } from "../../venues/domain/venue-market";

export interface PmxtAuthoritativeMarketSnapshotRepository {
  listByScanRunId(scanRunId: string): Promise<readonly VenueMarketSnapshot[]>;
}
