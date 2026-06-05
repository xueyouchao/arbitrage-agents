import { describe, expect, it } from "vitest";
import { uuidFromStableKey } from "../src/contexts/shared/stable-id";

describe("uuidFromStableKey", () => {
  it("generates deterministic UUID-shaped IDs from stable keys", () => {
    expect(uuidFromStableKey("market:kalshi:K1")).toBe(uuidFromStableKey("market:kalshi:K1"));
    expect(uuidFromStableKey("market:kalshi:K1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromStableKey("market:kalshi:K1")).not.toBe(uuidFromStableKey("market:kalshi:K2"));
  });
});
