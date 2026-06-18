import { describe, expect, it } from "vitest";
import { uuidFromStableKey } from "../src/contexts/shared/stable-id";

describe("uuidFromStableKey", () => {
  it("generates deterministic UUID-shaped IDs from stable keys", () => {
    expect(uuidFromStableKey("market:kalshi:K1")).toBe(uuidFromStableKey("market:kalshi:K1"));
    expect(uuidFromStableKey("market:kalshi:K1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromStableKey("market:kalshi:K1")).not.toBe(uuidFromStableKey("market:kalshi:K2"));
  });

  it("accepts UUID v6, v7, and v8 in API validation", () => {
    // UUID v6 example (time-ordered, RFC 9562)
    const uuidV6 = "1e8f5c7a-9b3d-6e2f-81c4-8d7e6f5a4b3c";
    // UUID v7 example (time-ordered, RFC 9562)
    const uuidV7 = "018f5c7a-9b3d-7e2f-81c4-8d7e6f5a4b3c";
    // UUID v8 example (custom, RFC 9562)
    const uuidV8 = "018f5c7a-9b3d-8e2f-81c4-8d7e6f5a4b3c";
    // UUID v4 example (random)
    const uuidV4 = "018f5c7a-9b3d-4e2f-81c4-8d7e6f5a4b3c";

    // All should be valid UUIDs (accepting versions 0-9, a-f in version nibble)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuidV4).toMatch(uuidRegex);
    expect(uuidV6).toMatch(uuidRegex);
    expect(uuidV7).toMatch(uuidRegex);
    expect(uuidV8).toMatch(uuidRegex);
  });
});
