import { describe, expect, it } from "vitest";
import {
  PmxtRouterCluster,
  projectPmxtRouterMatches,
} from "../../src/contexts/scanner/pmxt/pmxt-router-match-projector";

function cluster(overrides: Partial<PmxtRouterCluster> = {}): PmxtRouterCluster {
  return {
    clusterId: "cluster-1",
    canonicalTitle: "Will BTC exceed $100,000?",
    relations: ["identity"],
    confidence: 0.99,
    markets: [
      {
        marketId: "pmxt-kalshi-1",
        sourceExchange: "kalshi",
        title: "Will BTC exceed $100,000?",
      },
      {
        marketId: "pmxt-polymarket-1",
        sourceExchange: "polymarket",
        title: "Will BTC exceed $100,000?",
      },
    ],
    rawMatches: [],
    ...overrides,
  };
}

const nativeIdentities = {
  "pmxt-kalshi-1": "KXBTC-100K",
  "pmxt-polymarket-1": "0xAbC123",
};

describe("projectPmxtRouterMatches", () => {
  it("does not create a pair from cluster membership alone", () => {
    const input = cluster();

    const result = projectPmxtRouterMatches([input], nativeIdentities);

    expect(result.clusters).toEqual([input]);
    expect(result.edges).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("does not infer a transitive Kalshi/Polymarket edge", () => {
    const input = cluster({
      markets: [
        ...cluster().markets,
        {
          marketId: "pmxt-third-party-1",
          sourceExchange: "manifold",
          title: "Will BTC exceed $100,000?",
        },
      ],
      rawMatches: [
        {
          marketAId: "pmxt-kalshi-1",
          marketBId: "pmxt-third-party-1",
          relation: "identity",
          confidence: 0.91,
        },
        {
          marketAId: "pmxt-third-party-1",
          marketBId: "pmxt-polymarket-1",
          relation: "identity",
          confidence: 0.9,
        },
      ],
    });

    const result = projectPmxtRouterMatches([input], nativeIdentities);

    expect(result.edges).toHaveLength(2);
    expect(result.candidates).toEqual([]);
    expect(result.edges.map((edge) => edge.exclusionReason)).toEqual([
      "unsupported_venue",
      "unsupported_venue",
    ]);
  });

  it("retains a non-identity edge but excludes it from default candidates", () => {
    const input = cluster({
      relations: ["identity", "subset"],
      confidence: 0.95,
      rawMatches: [
        {
          marketAId: "pmxt-kalshi-1",
          marketBId: "pmxt-polymarket-1",
          relation: "subset",
          confidence: 0.72,
        },
      ],
    });

    const result = projectPmxtRouterMatches([input], nativeIdentities);

    expect(result.candidates).toEqual([]);
    expect(result.edges).toEqual([
      expect.objectContaining({
        clusterId: "cluster-1",
        marketAId: "pmxt-kalshi-1",
        marketBId: "pmxt-polymarket-1",
        relation: "subset",
        confidence: 0.72,
        clusterRelations: ["identity", "subset"],
        clusterConfidence: 0.95,
        kalshiMemberId: "pmxt-kalshi-1",
        polymarketMemberId: "pmxt-polymarket-1",
        kalshiNativeId: "KXBTC-100K",
        polymarketNativeId: "0xAbC123",
        eligibleByDefault: false,
        exclusionReason: "non_identity_relation",
      }),
    ]);
  });

  it("projects only a direct identifiable identity edge with preserved metadata", () => {
    const input = cluster({
      relations: ["identity", "overlap"],
      confidence: 0.96,
      rawMatches: [
        {
          marketAId: "pmxt-polymarket-1",
          marketBId: "pmxt-kalshi-1",
          relation: "identity",
          confidence: 0.88,
        },
      ],
    });

    const result = projectPmxtRouterMatches([input], nativeIdentities);

    expect(result.edges).toEqual([
      expect.objectContaining({
        relation: "identity",
        confidence: 0.88,
        clusterConfidence: 0.96,
        kalshiMemberId: "pmxt-kalshi-1",
        polymarketMemberId: "pmxt-polymarket-1",
        kalshiNativeId: "KXBTC-100K",
        polymarketNativeId: "0xAbC123",
        eligibleByDefault: true,
      }),
    ]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        clusterId: "cluster-1",
        relation: "identity",
        confidence: 0.88,
        kalshiMemberId: "pmxt-kalshi-1",
        polymarketMemberId: "pmxt-polymarket-1",
        kalshiNativeId: "KXBTC-100K",
        polymarketNativeId: "0xAbC123",
      }),
    ]);
    expect(result.candidates[0].id).toMatch(/^pmxt-router:v1:/);
    expect(result.candidates[0].id).not.toBe(
      "kalshi:KXBTC-100K:polymarket:0xAbC123"
    );
    expect(result.clusters[0]).toBe(input);
    expect(result.edges[0].rawEdge).toBe(input.rawMatches?.[0]);
    expect(result.edges[0].kalshiMember).toBe(input.markets[0]);
    expect(result.edges[0].polymarketMember).toBe(input.markets[1]);
  });

  it.each<{
    name: string;
    input: PmxtRouterCluster;
    identities: Readonly<Record<string, string>>;
    reason: string;
  }>([
    {
      name: "an endpoint is missing from cluster members",
      input: cluster({
        rawMatches: [
          {
            marketAId: "pmxt-kalshi-1",
            marketBId: "missing",
            relation: "identity",
            confidence: 0.8,
          },
        ],
      }),
      identities: nativeIdentities,
      reason: "missing_edge_member",
    },
    {
      name: "a member ID is duplicated",
      input: cluster({
        markets: [cluster().markets[0], cluster().markets[0], cluster().markets[1]],
        rawMatches: [
          {
            marketAId: "pmxt-kalshi-1",
            marketBId: "pmxt-polymarket-1",
            relation: "identity",
            confidence: 0.8,
          },
        ],
      }),
      identities: nativeIdentities,
      reason: "ambiguous_edge_member",
    },
    {
      name: "a native identity is unavailable",
      input: cluster({
        rawMatches: [
          {
            marketAId: "pmxt-kalshi-1",
            marketBId: "pmxt-polymarket-1",
            relation: "identity",
            confidence: 0.8,
          },
        ],
      }),
      identities: { "pmxt-kalshi-1": "KXBTC-100K" },
      reason: "missing_native_identity",
    },
    {
      name: "both endpoints belong to one venue",
      input: cluster({
        markets: [
          cluster().markets[0],
          {
            marketId: "pmxt-kalshi-2",
            sourceExchange: "kalshi",
            title: "Another Kalshi market",
          },
        ],
        rawMatches: [
          {
            marketAId: "pmxt-kalshi-1",
            marketBId: "pmxt-kalshi-2",
            relation: "identity",
            confidence: 0.8,
          },
        ],
      }),
      identities: {
        "pmxt-kalshi-1": "KXBTC-100K",
        "pmxt-kalshi-2": "KXBTC-100K-B",
      },
      reason: "same_venue",
    },
  ])("fails closed when $name", ({ input, identities, reason }) => {
    const result = projectPmxtRouterMatches([input], identities);

    expect(result.candidates).toEqual([]);
    expect(result.edges[0].eligibleByDefault).toBe(false);
    expect(result.edges[0].exclusionReason).toBe(reason);
  });

  it("stores duplicate raw edges but emits one candidate ID", () => {
    const rawEdge = {
      marketAId: "pmxt-kalshi-1",
      marketBId: "pmxt-polymarket-1",
      relation: "identity" as const,
      confidence: 0.9,
    };

    const result = projectPmxtRouterMatches(
      [cluster({ rawMatches: [rawEdge, { ...rawEdge }] })],
      nativeIdentities
    );

    expect(result.edges).toHaveLength(2);
    expect(result.candidates).toHaveLength(1);
  });

  it("uses an unambiguous candidate ID even when source IDs contain separators", () => {
    const first = cluster({
      clusterId: "a:b",
      rawMatches: [
        {
          marketAId: "pmxt-kalshi-1",
          marketBId: "pmxt-polymarket-1",
          relation: "identity",
          confidence: 0.9,
        },
      ],
    });
    const second = cluster({
      clusterId: "a",
      markets: [
        { ...cluster().markets[0], marketId: "b:pmxt-kalshi-1" },
        cluster().markets[1],
      ],
      rawMatches: [
        {
          marketAId: "b:pmxt-kalshi-1",
          marketBId: "pmxt-polymarket-1",
          relation: "identity",
          confidence: 0.9,
        },
      ],
    });

    const firstId = projectPmxtRouterMatches([first], nativeIdentities).candidates[0].id;
    const secondId = projectPmxtRouterMatches([second], {
      ...nativeIdentities,
      "b:pmxt-kalshi-1": "KXBTC-100K",
    }).candidates[0].id;

    expect(firstId).not.toBe(secondId);
  });
});
