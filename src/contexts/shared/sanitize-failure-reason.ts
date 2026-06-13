// Shared failure-reason scrubber.
//
// Used by the scanner (`ReadOnlyScanner` / `ResumableScanner`) to redact
// secrets, URLs, and provider tokens from arbitrary `unknown` errors
// before the text is persisted to `scan_runs.failure_reason`,
// `scan_steps.failure_reason`, Sentry check-in payloads, and operator
// logs. Centralizing the function (Phase 4 review Finding #8) means the
// scrubber rules live in one place — the next time a leaked-secret
// pattern is discovered (a new API key prefix, an OAuth token shape, a
// partner credential format) the engineer updates one file and every
// scan path benefits.
//
// The output is bounded to 200 characters to keep `scan_runs.failure_reason`
// from holding unbounded error blobs in the database.

import { redactSensitiveText } from "../../config/redaction";

const MAX_FAILURE_REASON_LENGTH = 200;

export function sanitizeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/token[_-]?id=[^\s&]+/gi, "token_id=[redacted]")
    .replace(/(api[_-]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;}&]+/gi, "$1$2[REDACTED]")
    .slice(0, MAX_FAILURE_REASON_LENGTH);
}
