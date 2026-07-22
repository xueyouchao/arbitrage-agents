import { bothCryptoPriceLevels } from "./crypto-market";

export const DEFAULT_DEADLINE_TOLERANCE_MS = 60 * 1000;
export const EXACT_THRESHOLD_TOLERANCE = 1e-6;
export const CRYPTO_THRESHOLD_TOLERANCE = 1;

interface MarketKind {
  readonly topic: string;
  readonly eventType: string;
}

export interface CompatibilityMatch {
  exact: boolean;
  compatible: boolean;
}

export function thresholdsCompatible(
  left?: number,
  right?: number,
  leftMarket?: MarketKind,
  rightMarket?: MarketKind,
): CompatibilityMatch {
  if (left === undefined && right === undefined) {
    return { exact: true, compatible: true };
  }
  if (left === undefined || right === undefined) {
    return { exact: false, compatible: false };
  }

  const diff = Math.abs(left - right);
  if (diff < EXACT_THRESHOLD_TOLERANCE) {
    return { exact: true, compatible: true };
  }

  if (
    leftMarket &&
    rightMarket &&
    bothCryptoPriceLevels(leftMarket, rightMarket) &&
    diff <= CRYPTO_THRESHOLD_TOLERANCE
  ) {
    return { exact: false, compatible: true };
  }

  return { exact: false, compatible: false };
}

export function deadlinesCompatible(
  left?: string,
  right?: string,
  leftMarket?: MarketKind,
  rightMarket?: MarketKind,
): CompatibilityMatch {
  if (!left || !right) {
    return { exact: false, compatible: false };
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return { exact: false, compatible: false };
  }

  const diffMs = Math.abs(leftTime - rightTime);
  if (diffMs <= DEFAULT_DEADLINE_TOLERANCE_MS) {
    return { exact: true, compatible: true };
  }

  if (
    leftMarket &&
    rightMarket &&
    bothCryptoPriceLevels(leftMarket, rightMarket) &&
    sameUtcDay(leftTime, rightTime)
  ) {
    return { exact: false, compatible: true };
  }

  return { exact: false, compatible: false };
}

function sameUtcDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}
