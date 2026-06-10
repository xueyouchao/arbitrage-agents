# Config

## Purpose

`src/config/` owns environment parsing, validated application configuration, and sensitive-data redaction helpers.

## Ownership

- Environment variable names, defaults, validation, and exported app config types are owned here.
- Redaction patterns for logs, errors, and persisted failure text are owned here.

## Local Contracts

- Add new environment variables through the central app config schema instead of scattered `process.env` reads.
- Treat database URLs, DSNs, API keys, auth headers, tokens, passwords, wallet/private keys, emails, and PII as sensitive.
- Route user-visible, logged, or persisted error text through redaction helpers when it may include external payloads or configuration.
- Keep config validation deterministic and fail-fast at startup.

## Work Guidance

- Update tests when adding required environment variables or changing defaults.
- Prefer explicit config fields over passing raw environment maps through the application.
- Extend redaction patterns conservatively; avoid patterns that corrupt ordinary diagnostic text.

## Verification

- Run `npm run typecheck` after config type changes.
- Run `npm test -- config` or `npm test` after validation/redaction behavior changes.

## Child DOX Index

No child DOX files are currently needed here.
