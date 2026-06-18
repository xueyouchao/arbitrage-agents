// Sentry SDK-backed observability sink. Translates redacted
// ObservabilityService events into Sentry issues so that
// captureError() calls surface in the Sentry Issues feed and
// captureInfo() calls appear as breadcrumb-level events.
//
// The sink is intentionally thin: it delegates to the Sentry global
// scope (Sentry.captureMessage / Sentry.withScope) which is
// initialised by the ObservabilityModule when SENTRY_DSN is set.
// When Sentry is not initialised (no DSN, tests, local dev) the
// calls are no-ops — Sentry v10 silently drops events when the SDK
// has not been started.
//
// The original Error stack trace is intentionally NOT forwarded:
// ObservabilityService redacts the message and metadata before
// handing them to the sink, and the redacted string is all that
// reaches Sentry. This trades stack-trace fidelity for a guarantee
// that no raw secret ever leaks into an issue payload.

import * as Sentry from "@sentry/node";
import { CapturedObservabilityEvent, ObservabilitySink } from "./observability.service";

export class SentryObservabilitySink implements ObservabilitySink {
  capture(event: CapturedObservabilityEvent): void {
    const level = event.level === "error" ? ("error" as const) : ("info" as const);

    Sentry.withScope((scope) => {
      scope.setLevel(level);

      // Scalar metadata becomes Sentry tags (searchable / filterable).
      // Nested objects go into a single "context" block so they remain
      // inspectable on the issue detail page without polluting the tag
      // index.
      const tags: Record<string, string> = {};
      const contextData: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(event.metadata)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          tags[key] = String(value);
        } else {
          contextData[key] = value;
        }
      }

      for (const [key, value] of Object.entries(tags)) {
        scope.setTag(key, value);
      }

      if (Object.keys(contextData).length > 0) {
        scope.setContext("event_metadata", contextData);
      }

      Sentry.captureMessage(event.message, level);
    });
  }
}
