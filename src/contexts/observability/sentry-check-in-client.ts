// Phase 4: Sentry cron-monitor check-in client.
//
// The worker's health is published as a Sentry cron monitor so the Sentry
// dashboard reflects each scheduled scan in real time. The HTTP shape
// follows Sentry's public envelope endpoint: a POST to
// `${envelopeEndpoint}/?sentry_key=...&sentry_version=7` with a JSON
// envelope body whose only item is a `check_in` type. The first call
// (`start`) creates the run; subsequent calls (`ok` / `error`) reference
// the same `check_in_id` returned by `start`.
//
// The transport is intentionally small and dependency-free: the worker
// must be able to ship a check-in even when the full Sentry SDK is not
// installed. The `FakeSentryCheckInClient` is used by tests and by the
// worker when `SENTRY_DSN` is unset, so local/test runs do not need live
// Sentry credentials.
//
// The client is stateless: `start()` returns a `SentryCheckInHandle`
// opaque object, and `ok` / `error` consume that handle. This avoids
// the per-instance active-run state that previously produced races
// when two `runOnce` invocations overlapped on the same Nest singleton
// (Phase 4 review Finding #5).

export type SentryCheckInStatus = "in_progress" | "ok" | "error";

export interface CapturedCheckIn {
  slug: string;
  checkInId: string;
  status: SentryCheckInStatus;
  startedAt: string;
}

// Opaque handle returned by `start()`. Bundles the slug, check-in id,
// and the original `startedAt` so `ok` / `error` can compute the
// duration without needing to consult any instance state.
export interface SentryCheckInHandle {
  readonly slug: string;
  readonly checkInId: string;
  readonly startedAt: Date;
}

export interface SentryCheckInClient {
  // Start a new check-in. Returns an opaque handle that the worker
  // must pass back to `ok` / `error`.
  start(monitorSlug: string, startedAt: Date): Promise<SentryCheckInHandle>;
  ok(handle: SentryCheckInHandle, finishedAt: Date): Promise<void>;
  error(handle: SentryCheckInHandle, finishedAt: Date): Promise<void>;
}

export interface SentryHttpCheckInClientOptions {
  dsn: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

// Parse a Sentry DSN of the form `https://<publicKey>@<host>/<projectId>`.
// Returns the envelope endpoint and the `sentry_key` query parameter
// fragment. We intentionally do NOT validate the project id beyond a
// positive integer; any syntactically valid DSN is accepted.
export function parseSentryDsn(dsn: string): { envelopeEndpoint: string; sentryKey: string } {
  const url = new URL(dsn);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Sentry DSN must use http(s); got ${url.protocol}`);
  }
  const publicKey = url.username;
  if (!publicKey) {
    throw new Error("Sentry DSN is missing a public key");
  }
  const projectId = url.pathname.replace(/^\/+/, "").split("/")[0];
  if (!/^\d+$/.test(projectId)) {
    throw new Error(`Sentry DSN project id must be numeric; got ${projectId || "<empty>"}`);
  }
  const envelopeEndpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
  return { envelopeEndpoint, sentryKey: publicKey };
}

interface SentryCheckInItem {
  type: "check_in";
  content_type: "application/json";
  payload: Record<string, unknown>;
}

interface SentryEnvelope {
  event_id: string;
  sent_at: string;
  sdk: { name: string; version: string };
  items: SentryCheckInItem[];
}

function randomId(): string {
  // crypto.randomUUID is available in Node 19+; the worker requires
  // Node >= 20 per package.json engines.
  return crypto.randomUUID();
}

export class SentryHttpCheckInClient implements SentryCheckInClient {
  private readonly envelopeEndpoint: string;
  private readonly sentryKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: SentryHttpCheckInClientOptions) {
    const parsed = parseSentryDsn(options.dsn);
    this.envelopeEndpoint = parsed.envelopeEndpoint;
    this.sentryKey = parsed.sentryKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async start(monitorSlug: string, startedAt: Date): Promise<SentryCheckInHandle> {
    // Sentry's check-in protocol expects the client to mint a check_in_id
    // and Sentry will echo it on subsequent ok/error calls. We mint a
    // stable UUID locally so `ok`/`error` can be called without an extra
    // round-trip lookup. If the Sentry response includes an `id` field
    // we use that as the canonical id, otherwise we keep the locally
    // minted one — both are valid forms of the protocol.
    const localId = randomId();
    const responseId = await this.send(monitorSlug, localId, "in_progress", startedAt, undefined);
    const checkInId = responseId ?? localId;
    return { slug: monitorSlug, checkInId, startedAt };
  }

  ok(handle: SentryCheckInHandle, finishedAt: Date): Promise<void> {
    return this.send(handle.slug, handle.checkInId, "ok", handle.startedAt, finishedAt).then(() => undefined);
  }

  error(handle: SentryCheckInHandle, finishedAt: Date): Promise<void> {
    return this.send(handle.slug, handle.checkInId, "error", handle.startedAt, finishedAt).then(() => undefined);
  }

  // Direct send exposed so the orchestrator wrapper can pair start() and
  // ok()/error() with the same monitor slug. Returns the response's
  // `id` field when the server echoes a check_in id, or `undefined` if
  // the response body has no id.
  async send(
    monitorSlug: string,
    checkInId: string,
    status: SentryCheckInStatus,
    startedAt: Date,
    finishedAt: Date | undefined
  ): Promise<string | undefined> {
    const duration = finishedAt ? Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)) : undefined;
    const payload: Record<string, unknown> = {
      check_in_id: checkInId,
      monitor_slug: monitorSlug,
      status,
      timestamp: Math.round(startedAt.getTime() / 1000)
    };
    if (duration !== undefined) payload.duration = duration;

    const envelope: SentryEnvelope = {
      event_id: randomId().replace(/-/g, ""),
      sent_at: new Date(this.now().getTime()).toISOString(),
      sdk: { name: "arbitrage-agents-sentry", version: "0.1.0" },
      items: [{ type: "check_in", content_type: "application/json", payload }]
    };

    const url = `${this.envelopeEndpoint}?sentry_key=${encodeURIComponent(this.sentryKey)}&sentry_version=7`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: JSON.stringify(envelope),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Sentry check-in failed: HTTP ${response.status}`);
      }
      // Sentry returns a JSON body of the form { "id": "..." } for
      // accepted check-ins. We read it best-effort: missing or malformed
      // responses are tolerated and the local id is kept.
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { id?: string };
        return typeof parsed.id === "string" ? parsed.id : undefined;
      } catch {
        return undefined;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// In-process fake used by tests and by local worker runs when no DSN is
// configured. Captures every check-in for later inspection and supports
// injection of failures via `failNext()`. The fake is also stateless
// with respect to the active run — `ok` / `error` take the handle and
// read the slug/checkInId from it.
export class FakeSentryCheckInClient implements SentryCheckInClient {
  readonly checkIns: CapturedCheckIn[] = [];
  private failOnce = false;

  failNext(): void {
    this.failOnce = true;
  }

  async start(monitorSlug: string, startedAt: Date): Promise<SentryCheckInHandle> {
    const checkInId = randomId();
    this.checkIns.push({ slug: monitorSlug, checkInId, status: "in_progress", startedAt: startedAt.toISOString() });
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("FakeSentryCheckInClient: injected failure");
    }
    return { slug: monitorSlug, checkInId, startedAt };
  }

  ok(handle: SentryCheckInHandle, finishedAt: Date): Promise<void> {
    this.checkIns.push({ slug: handle.slug, checkInId: handle.checkInId, status: "ok", startedAt: finishedAt.toISOString() });
    return Promise.resolve();
  }

  error(handle: SentryCheckInHandle, finishedAt: Date): Promise<void> {
    this.checkIns.push({ slug: handle.slug, checkInId: handle.checkInId, status: "error", startedAt: finishedAt.toISOString() });
    return Promise.resolve();
  }
}
