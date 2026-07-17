export type PmxtRouterMatchRelation =
  | "identity"
  | "complement"
  | "subset"
  | "superset"
  | "overlap"
  | "disjoint";

export interface PmxtRouterMember {
  marketId: string;
  sourceExchange?: string;
  title: string;
  description?: string;
  resolutionDate?: Date | string;
  [key: string]: unknown;
}

export interface PmxtRouterRawMatch {
  marketAId: string;
  marketBId: string;
  relation: PmxtRouterMatchRelation;
  confidence: number;
}

export interface PmxtRouterCluster {
  clusterId: string;
  canonicalTitle: string | null;
  relations: PmxtRouterMatchRelation[];
  confidence: number;
  markets: PmxtRouterMember[];
  rawMatches?: PmxtRouterRawMatch[];
  [key: string]: unknown;
}

export type PmxtRouterEdgeExclusionReason =
  | "missing_edge_member"
  | "ambiguous_edge_member"
  | "missing_source_exchange"
  | "unsupported_venue"
  | "same_venue"
  | "missing_native_identity"
  | "non_identity_relation";

export interface PmxtRouterProjectedEdge {
  clusterId: string;
  marketAId: string;
  marketBId: string;
  relation: PmxtRouterMatchRelation;
  confidence: number;
  clusterRelations: PmxtRouterMatchRelation[];
  clusterConfidence: number;
  kalshiMemberId?: string;
  polymarketMemberId?: string;
  kalshiNativeId?: string;
  polymarketNativeId?: string;
  kalshiMember?: PmxtRouterMember;
  polymarketMember?: PmxtRouterMember;
  eligibleByDefault: boolean;
  exclusionReason?: PmxtRouterEdgeExclusionReason;
  rawEdge: PmxtRouterRawMatch;
}

export interface PmxtRouterCandidate {
  id: string;
  clusterId: string;
  relation: "identity";
  confidence: number;
  kalshiMemberId: string;
  polymarketMemberId: string;
  kalshiNativeId: string;
  polymarketNativeId: string;
}

export interface PmxtRouterProjectionResult {
  clusters: PmxtRouterCluster[];
  edges: PmxtRouterProjectedEdge[];
  candidates: PmxtRouterCandidate[];
}

export type PmxtRouterNativeIdentities = Readonly<Record<string, string>>;

type SupportedVenue = "kalshi" | "polymarket";

export function projectPmxtRouterMatches(
  clusters: PmxtRouterCluster[],
  nativeIdentities: PmxtRouterNativeIdentities
): PmxtRouterProjectionResult {
  const edges: PmxtRouterProjectedEdge[] = [];
  const candidates: PmxtRouterCandidate[] = [];

  for (const cluster of clusters) {
    const membersById = new Map<string, PmxtRouterMember[]>();
    for (const member of cluster.markets) {
      const members = membersById.get(member.marketId) ?? [];
      members.push(member);
      membersById.set(member.marketId, members);
    }

    for (const rawEdge of cluster.rawMatches ?? []) {
      const projectedEdge = projectEdge(cluster, rawEdge, membersById, nativeIdentities);
      edges.push(projectedEdge);

      if (
        projectedEdge.eligibleByDefault &&
        projectedEdge.kalshiMemberId &&
        projectedEdge.polymarketMemberId &&
        projectedEdge.kalshiNativeId &&
        projectedEdge.polymarketNativeId
      ) {
        candidates.push({
          id: routerCandidateId(
            cluster.clusterId,
            projectedEdge.kalshiMemberId,
            projectedEdge.polymarketMemberId
          ),
          clusterId: cluster.clusterId,
          relation: "identity",
          confidence: projectedEdge.confidence,
          kalshiMemberId: projectedEdge.kalshiMemberId,
          polymarketMemberId: projectedEdge.polymarketMemberId,
          kalshiNativeId: projectedEdge.kalshiNativeId,
          polymarketNativeId: projectedEdge.polymarketNativeId,
        });
      }
    }
  }

  return { clusters, edges, candidates };
}

function projectEdge(
  cluster: PmxtRouterCluster,
  rawEdge: PmxtRouterRawMatch,
  membersById: Map<string, PmxtRouterMember[]>,
  nativeIdentities: PmxtRouterNativeIdentities
): PmxtRouterProjectedEdge {
  const base = {
    clusterId: cluster.clusterId,
    marketAId: rawEdge.marketAId,
    marketBId: rawEdge.marketBId,
    relation: rawEdge.relation,
    confidence: rawEdge.confidence,
    clusterRelations: cluster.relations,
    clusterConfidence: cluster.confidence,
    eligibleByDefault: false,
    rawEdge,
  };
  const membersA = membersById.get(rawEdge.marketAId) ?? [];
  const membersB = membersById.get(rawEdge.marketBId) ?? [];

  if (membersA.length === 0 || membersB.length === 0) {
    return { ...base, exclusionReason: "missing_edge_member" };
  }
  if (membersA.length !== 1 || membersB.length !== 1) {
    return { ...base, exclusionReason: "ambiguous_edge_member" };
  }

  const memberA = membersA[0];
  const memberB = membersB[0];
  const venueA = supportedVenue(memberA.sourceExchange);
  const venueB = supportedVenue(memberB.sourceExchange);

  if (!normalizedVenue(memberA.sourceExchange) || !normalizedVenue(memberB.sourceExchange)) {
    return { ...base, exclusionReason: "missing_source_exchange" };
  }
  if (!venueA || !venueB) {
    return { ...base, exclusionReason: "unsupported_venue" };
  }
  if (venueA === venueB) {
    return { ...base, exclusionReason: "same_venue" };
  }

  const kalshiMember = venueA === "kalshi" ? memberA : memberB;
  const polymarketMember = venueA === "polymarket" ? memberA : memberB;
  const identities = {
    kalshiMemberId: kalshiMember.marketId,
    polymarketMemberId: polymarketMember.marketId,
    kalshiNativeId: nonEmpty(nativeIdentities[kalshiMember.marketId]),
    polymarketNativeId: nonEmpty(nativeIdentities[polymarketMember.marketId]),
    kalshiMember,
    polymarketMember,
  };

  if (!identities.kalshiNativeId || !identities.polymarketNativeId) {
    return {
      ...base,
      ...identities,
      exclusionReason: "missing_native_identity",
    };
  }
  if (rawEdge.relation !== "identity") {
    return {
      ...base,
      ...identities,
      exclusionReason: "non_identity_relation",
    };
  }

  return {
    ...base,
    ...identities,
    eligibleByDefault: true,
  };
}

function normalizedVenue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function supportedVenue(value: string | undefined): SupportedVenue | undefined {
  const normalized = normalizedVenue(value);
  return normalized === "kalshi" || normalized === "polymarket"
    ? normalized
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function routerCandidateId(
  clusterId: string,
  kalshiMemberId: string,
  polymarketMemberId: string
): string {
  return [clusterId, kalshiMemberId, polymarketMemberId]
    .map((part) => encodeURIComponent(part))
    .join(":")
    .replace(/^/, "pmxt-router:v1:");
}
