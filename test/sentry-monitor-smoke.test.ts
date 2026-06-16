import { describe, expect, it, vi } from "vitest";
import { loadSentryMonitorSmokeConfig, runSentryMonitorSmokeCheck } from "../src/sentry-monitor-smoke";

describe("Sentry monitor smoke check", () => {
  it("requires real Sentry monitor environment variables", () => {
    expect(() =>
      loadSentryMonitorSmokeConfig({
        SENTRY_DSN: "",
        SENTRY_MONITOR_SLUG: ""
      })
    ).toThrow(/SENTRY_DSN and SENTRY_MONITOR_SLUG/);
  });

  it("posts an in_progress and ok check-in using the configured monitor slug", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: envelope.items?.[0]?.payload?.check_in_id }), { status: 200 });
    });

    const result = await runSentryMonitorSmokeCheck({
      config: {
        dsn: "https://public@example.com/1",
        monitorSlug: "worker-scan-test"
      },
      fetchImpl,
      now: () => new Date("2026-06-04T12:00:00Z")
    });

    expect(result.monitorSlug).toBe("worker-scan-test");
    expect(result.checkInId).toEqual(expect.any(String));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const envelopes = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(envelopes.map((envelope) => envelope.items[0].payload.status)).toEqual(["in_progress", "ok"]);
    expect(envelopes.every((envelope) => envelope.items[0].payload.monitor_slug === "worker-scan-test")).toBe(true);
  });
});
