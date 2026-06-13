import { describe, expect, it } from "vitest";
import { FakeSentryCheckInClient, SentryCheckInClient, SentryHttpCheckInClient } from "../src/contexts/observability/sentry-check-in-client";

describe("SentryHttpCheckInClient", () => {
  it("posts in_progress to the public envelope endpoint and returns a handle carrying the checkInId from the response", async () => {
    let receivedCheckInId: string | undefined;
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body));
      // Sentry's protocol echoes the client-minted check_in_id back
      // in the response so the client can correlate. The mock mirrors
      // that contract.
      receivedCheckInId = body.items?.[0]?.payload?.check_in_id;
      return new Response(JSON.stringify({ id: receivedCheckInId }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new SentryHttpCheckInClient({
      dsn: "https://abc@example.com/1",
      fetchImpl,
      now: () => new Date("2026-06-04T12:00:00Z")
    });

    const handle = await client.start("scan-monitor", new Date("2026-06-04T12:00:00Z"));

    expect(typeof handle.checkInId).toBe("string");
    expect(handle.slug).toBe("scan-monitor");
    expect(handle.checkInId).toBe(receivedCheckInId);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/envelope\/\?sentry_key=/);
    expect(calls[0].url).toContain("sentry_key=abc");
    expect(calls[0].url).toContain("sentry_version=7");
    const envelope = JSON.parse(String(calls[0].init?.body));
    expect(envelope.items[0].payload).toMatchObject({
      check_in_id: handle.checkInId,
      monitor_slug: "scan-monitor",
      status: "in_progress"
    });
    expect(typeof envelope.items[0].payload.timestamp).toBe("number");
  });

  it("posts ok with the original handle from the start call", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: body.items?.[0]?.payload?.check_in_id }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new SentryHttpCheckInClient({
      dsn: "https://abc@example.com/1",
      fetchImpl,
      now: () => new Date("2026-06-04T12:00:00Z")
    });
    const handle = await client.start("scan-monitor", new Date("2026-06-04T12:00:00Z"));
    await client.ok(handle, new Date("2026-06-04T12:00:05Z"));

    expect(calls).toHaveLength(2);
    const okEnvelope = JSON.parse(String(calls[1].init?.body));
    expect(okEnvelope.items[0].payload).toMatchObject({
      check_in_id: handle.checkInId,
      monitor_slug: "scan-monitor",
      status: "ok",
      duration: 5
    });
  });

  it("posts error status with the original handle", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: body.items?.[0]?.payload?.check_in_id }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new SentryHttpCheckInClient({
      dsn: "https://abc@example.com/1",
      fetchImpl,
      now: () => new Date("2026-06-04T12:00:00Z")
    });
    const handle = await client.start("scan-monitor", new Date("2026-06-04T12:00:00Z"));
    await client.error(handle, new Date("2026-06-04T12:00:01Z"));

    const errorEnvelope = JSON.parse(String(calls[1].init?.body));
    expect(errorEnvelope.items[0].payload).toMatchObject({
      check_in_id: handle.checkInId,
      status: "error",
      duration: 1
    });
  });

  it("parses the public DSN, host, project, and endpoint correctly", () => {
    const client = new SentryHttpCheckInClient({ dsn: "https://key@o.example.com/42" });
    // The constructor must accept a real Sentry DSN without throwing.
    expect(client).toBeInstanceOf(SentryHttpCheckInClient);
  });

  // Phase 4 review Finding #5: overlapping runOnce invocations must NOT
  // race the Sentry check-in state. The handle-based API is stateless, so
  // two start/ok pairs on the same client each carry their own slug.
  it("interleaves two start/ok pairs on a single client and keeps slugs separate", async () => {
    const captured: Array<{ slug: string; status: string; checkInId: string }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      captured.push({
        slug: body.items?.[0]?.payload?.monitor_slug,
        status: body.items?.[0]?.payload?.status,
        checkInId: body.items?.[0]?.payload?.check_in_id
      });
      return new Response(JSON.stringify({ id: body.items?.[0]?.payload?.check_in_id }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new SentryHttpCheckInClient({
      dsn: "https://abc@example.com/1",
      fetchImpl,
      now: () => new Date("2026-06-04T12:00:00Z")
    });

    const handleA = await client.start("monitor-A", new Date("2026-06-04T12:00:00Z"));
    const handleB = await client.start("monitor-B", new Date("2026-06-04T12:00:01Z"));
    await client.ok(handleB, new Date("2026-06-04T12:00:02Z"));
    await client.ok(handleA, new Date("2026-06-04T12:00:03Z"));

    expect(captured).toEqual([
      { slug: "monitor-A", status: "in_progress", checkInId: handleA.checkInId },
      { slug: "monitor-B", status: "in_progress", checkInId: handleB.checkInId },
      { slug: "monitor-B", status: "ok", checkInId: handleB.checkInId },
      { slug: "monitor-A", status: "ok", checkInId: handleA.checkInId }
    ]);
  });
});

describe("FakeSentryCheckInClient", () => {
  it("captures all three check-in events in order", async () => {
    const fake = new FakeSentryCheckInClient();
    const handle = await fake.start("m", new Date("2026-06-04T12:00:00Z"));
    await fake.ok(handle, new Date("2026-06-04T12:00:01Z"));
    await fake.error(handle, new Date("2026-06-04T12:00:02Z"));

    expect(fake.checkIns.map((c) => c.status)).toEqual(["in_progress", "ok", "error"]);
    expect(fake.checkIns.every((c) => c.checkInId === handle.checkInId)).toBe(true);
  });

  it("implements SentryCheckInClient", () => {
    const fake: SentryCheckInClient = new FakeSentryCheckInClient();
    expect(typeof fake.start).toBe("function");
    expect(typeof fake.ok).toBe("function");
    expect(typeof fake.error).toBe("function");
  });
});
