import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export interface PmxtSdkVersionEntry {
  package: string;
  version: string;
  license: string;
}

export interface PmxtSdkIntegrityEntry {
  package: string;
  version: string;
  sha512: string;
}

export interface PmxtEndpointAvailability {
  hostedBaseUrl: string;
  tradeBaseUrl: string;
  catalogEndpoints: string[];
  tradingEndpoints: string[];
  accountEndpoints: string[];
}

export interface PmxtFreeTierLimits {
  maxRequestsPerMinute: number;
  maxConcurrency: number;
  walletAddressRequired: boolean;
  bulkCallBilling: string;
  quotaExhaustionBehavior: string;
  rateLimitHeaders: string[];
}

export interface PmxtMarketIdentity {
  marketIdField: string;
  outcomeIdField: string;
  binaryOrientation: string;
  timestampFormat: string;
  timestampField: string;
}

export interface PmxtOperatingBoundary {
  excludesExecution: boolean;
  excludesAccountAccess: boolean;
  excludesCommercialResale: boolean;
  excludesCompetitiveProduct: boolean;
  excludesPublicBenchmark: boolean;
  excludesReverseEngineering: boolean;
  excludesControlCircumvention: boolean;
  excludesDatabaseReconstruction: boolean;
}

export interface PmxtShadowMetadata {
  recordedAt: string;
  sdkVersions: PmxtSdkVersionEntry[];
  sdkIntegrity: PmxtSdkIntegrityEntry[];
  endpointAvailability: PmxtEndpointAvailability;
  freeTierLimits: PmxtFreeTierLimits;
  marketIdentity: PmxtMarketIdentity;
  operatingBoundary: PmxtOperatingBoundary;
}

function readPackageJson(packageName: string): Record<string, unknown> {
  const pkgPath = join("node_modules", packageName, "package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files.sort();
}

export function computePmxtSdkIntegrity(
  packageName: string
): PmxtSdkIntegrityEntry {
  const pkg = readPackageJson(packageName);
  const version = String(pkg.version);
  const pkgDir = join("node_modules", packageName);

  const hash = createHash("sha512");
  hash.update(`${packageName}@${version}`);

  for (const filePath of walkFiles(pkgDir)) {
    const rel = relative(pkgDir, filePath);
    hash.update(rel);
    hash.update(readFileSync(filePath));
  }

  return {
    package: packageName,
    version,
    sha512: hash.digest("hex"),
  };
}

export function collectPmxtShadowMetadata(): PmxtShadowMetadata {
  const pmxtjsPkg = readPackageJson("pmxtjs");
  const pmxtCorePkg = readPackageJson("pmxt-core");

  const sdkVersions: PmxtSdkVersionEntry[] = [
    {
      package: "pmxtjs",
      version: String(pmxtjsPkg.version),
      license: String(pmxtjsPkg.license ?? "MIT"),
    },
    {
      package: "pmxt-core",
      version: String(pmxtCorePkg.version),
      license: String(pmxtCorePkg.license ?? "MIT"),
    },
  ];

  const sdkIntegrity: PmxtSdkIntegrityEntry[] = [
    computePmxtSdkIntegrity("pmxtjs"),
    computePmxtSdkIntegrity("pmxt-core"),
  ];

  const endpointAvailability: PmxtEndpointAvailability = {
    hostedBaseUrl: "https://api.pmxt.dev",
    tradeBaseUrl: "https://trade.pmxt.dev",
    catalogEndpoints: [
      "fetchMarkets",
      "fetchOrderBooks",
      "fetchOHLCV",
      "fetchTrades",
      "fetchEvents",
    ],
    tradingEndpoints: ["createOrder", "cancelOrder"],
    accountEndpoints: ["fetchBalance", "fetchPositions"],
  };

  const freeTierLimits: PmxtFreeTierLimits = {
    maxRequestsPerMinute: 60,
    maxConcurrency: 1,
    walletAddressRequired: true,
    bulkCallBilling:
      "Each outcomeId in a bulk fetchOrderBooks call counts as a separate request toward the rate limit and monthly credit quota",
    quotaExhaustionBehavior:
      "When the monthly credit quota is exhausted, the hosted API returns HTTP 429 (Too Many Requests) with a Retry-After header; no further requests are served until the next billing cycle",
    rateLimitHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
  };

  const marketIdentity: PmxtMarketIdentity = {
    marketIdField: "marketId",
    outcomeIdField: "outcomeId",
    binaryOrientation:
      "Binary markets express YES/NO via outcome labels 'Yes'/'No' (case-insensitive); the SDK also exposes convenience accessors market.yes and market.no on UnifiedMarket",
    timestampFormat: "unix-milliseconds",
    timestampField: "timestamp",
  };

  const operatingBoundary: PmxtOperatingBoundary = {
    excludesExecution: true,
    excludesAccountAccess: true,
    excludesCommercialResale: true,
    excludesCompetitiveProduct: true,
    excludesPublicBenchmark: true,
    excludesReverseEngineering: true,
    excludesControlCircumvention: true,
    excludesDatabaseReconstruction: true,
  };

  return {
    recordedAt: new Date().toISOString(),
    sdkVersions,
    sdkIntegrity,
    endpointAvailability,
    freeTierLimits,
    marketIdentity,
    operatingBoundary,
  };
}
