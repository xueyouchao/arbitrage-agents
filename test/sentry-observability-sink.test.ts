import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentryObservabilitySink } from "../src/contexts/observability/sentry-observability-sink";
import { ObservabilityService } from "../src/contexts/observability/observability.service";

// Mock the Sentry SDK so we can assert on the calls without
// hitting the network.
vi.mock("@sentry/node", () => {
  const captureMessage = vi.fn();
  const setLevel = vi.fn();
  const setTag = vi.fn();
  const setContext = vi.fn();
  type FakeScope = { setLevel: typeof setLevel; setTag: typeof setTag; setContext: typeof setContext };
  const scope: FakeScope = { setLevel, setTag, setContext };
  const withScope = vi.fn((cb: (scope: FakeScope) => void) => cb(scope));

  return {
    captureMessage,
    withScope,
    init: vi.fn(),
    close: vi.fn()
  };
});

// Import after vi.mock so the mock is active.
import * as Sentry from "@sentry/node";

describe("SentryObservabilitySink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures error-level events as Sentry messages with level 'error'", () => {
    const sink = new SentryObservabilitySink();

    sink.capture({ level: "error", message: "something broke", metadata: {}, startedAt: "" } as any);

    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith("something broke", "error");
  });

  it("captures info-level events as Sentry messages with level 'info'", () => {
    const sink = new SentryObservabilitySink();

    sink.capture({ level: "info", message: "scan complete", metadata: {} });

    expect(Sentry.captureMessage).toHaveBeenCalledWith("scan complete", "info");
  });

  it("sets scalar metadata as Sentry tags", () => {
    const sink = new SentryObservabilitySink();

    sink.capture({
      level: "error",
      message: "failed",
      metadata: { component: "scanner", retryCount: 3, fatal: true }
    });

    // Access the scope mock through the withScope callback.
    const scope = (Sentry.withScope as any).mock.calls[0][0];
    // Run the callback to exercise the scope.
    const fakeScope = { setLevel: vi.fn(), setTag: vi.fn(), setContext: vi.fn() };
    scope(fakeScope);

    expect(fakeScope.setTag).toHaveBeenCalledWith("component", "scanner");
    expect(fakeScope.setTag).toHaveBeenCalledWith("retryCount", "3");
    expect(fakeScope.setTag).toHaveBeenCalledWith("fatal", "true");
    expect(fakeScope.setContext).not.toHaveBeenCalled();
  });

  it("sets nested metadata as Sentry context instead of tags", () => {
    const sink = new SentryObservabilitySink();

    const nested = { venue: "polymarket", pairs: [{ a: 1, b: 2 }] };
    sink.capture({
      level: "error",
      message: "matching failed",
      metadata: { component: "matcher", details: nested }
    });

    const scope = (Sentry.withScope as any).mock.calls[0][0];
    const fakeScope = { setLevel: vi.fn(), setTag: vi.fn(), setContext: vi.fn() };
    scope(fakeScope);

    // "component" is scalar → tag
    expect(fakeScope.setTag).toHaveBeenCalledWith("component", "matcher");
    // "details" is an object → context
    expect(fakeScope.setContext).toHaveBeenCalledWith("event_metadata", { details: nested });
  });

  it("calls setLevel on the scope with the correct level", () => {
    const sink = new SentryObservabilitySink();

    sink.capture({ level: "error", message: "boom", metadata: {} });

    const scope = (Sentry.withScope as any).mock.calls[0][0];
    const fakeScope = { setLevel: vi.fn(), setTag: vi.fn(), setContext: vi.fn() };
    scope(fakeScope);

    expect(fakeScope.setLevel).toHaveBeenCalledWith("error");
  });
});

describe("ObservabilityService + SentryObservabilitySink integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redacts secrets before forwarding to the Sentry sink", () => {
    const sink = new SentryObservabilitySink();
    const service = new ObservabilityService(sink);

    service.captureError(
      new Error("provider failed https://example.test?api_key=secret"),
      { apiKey: "my-secret-key", safe: "visible" }
    );

    // The message should be redacted by ObservabilityService.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("[REDACTED]"),
      "error"
    );
    // apiKey metadata is redacted to "[REDACTED]" by ObservabilityService.
    const scope = (Sentry.withScope as any).mock.calls[0][0];
    const fakeScope = { setLevel: vi.fn(), setTag: vi.fn(), setContext: vi.fn() };
    scope(fakeScope);
    expect(fakeScope.setTag).toHaveBeenCalledWith("apiKey", "[REDACTED]");
    expect(fakeScope.setTag).toHaveBeenCalledWith("safe", "visible");
  });

  it("still captures events in capturedEvents array even with a sink", () => {
    const sink = new SentryObservabilitySink();
    const service = new ObservabilityService(sink);

    service.captureInfo("scan started", { scanId: "abc-123" });

    expect(service.capturedEvents).toHaveLength(1);
    expect(service.capturedEvents[0].level).toBe("info");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("scan started", "info");
  });
});
