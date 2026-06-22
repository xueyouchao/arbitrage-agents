#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CONTAINER="${ACCEPTANCE_POSTGRES_CONTAINER:-arb-acceptance-postgres}"
DB_PORT="${ACCEPTANCE_POSTGRES_PORT:-55432}"
DB_NAME="${ACCEPTANCE_POSTGRES_DB:-arbitrage_acceptance}"
DB_USER="${ACCEPTANCE_POSTGRES_USER:-postgres}"
DB_PASS="${ACCEPTANCE_POSTGRES_PASSWORD:-acceptance}"
TRACE_DIR="${ACCEPTANCE_CURL_TRACE_DIR:-/tmp/arb-http-trace}"
POSTGRES_IMAGE="${ACCEPTANCE_POSTGRES_IMAGE:-postgres:16-alpine}"
DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${DB_PORT}/${DB_NAME}"

# Resolve a working docker invocation: prefer plain `docker` (works when the
# user is in the docker group), fall back to passwordless `sudo docker`.
# Mirrors the detection logic in test/integration/postgres-test-database.ts.
# Probe with `docker info` (daemon socket access) rather than `docker run
# hello-world`, so a network/image-pull failure isn't misreported as a
# permissions problem.
DOCKER=()
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  printf 'docker is required for this acceptance wrapper; tried `docker` and `sudo -n docker`\n' >&2
  printf 'either join the docker group or enable passwordless sudo docker\n' >&2
  exit 1
fi

cleanup() {
  local status=$?
  "${DOCKER[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

if ss -ltn "sport = :${DB_PORT}" | grep -q ":${DB_PORT}"; then
  printf 'port %s is already in use; set ACCEPTANCE_POSTGRES_PORT to a free port\n' "$DB_PORT" >&2
  exit 1
fi

rm -rf "$TRACE_DIR"
mkdir -p "$TRACE_DIR"

"${DOCKER[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true

printf 'Starting disposable Postgres %s on 127.0.0.1:%s/%s...\n' "$POSTGRES_IMAGE" "$DB_PORT" "$DB_NAME"
"${DOCKER[@]}" run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:${DB_PORT}:5432" \
  "$POSTGRES_IMAGE" >/dev/null

for attempt in $(seq 1 60); do
  if "${DOCKER[@]}" exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    printf 'Disposable Postgres is ready.\n'
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    printf 'Disposable Postgres did not become ready. Container logs:\n' >&2
    "${DOCKER[@]}" logs "$CONTAINER" >&2 || true
    exit 1
  fi

  sleep 1
done

printf 'Running acceptance tests with curl traces in %s...\n' "$TRACE_DIR"
(
  cd "$ROOT_DIR"
  DATABASE_URL="$DATABASE_URL" \
    ACCEPTANCE_CONFIRM_DISPOSABLE_DATABASE=true \
    ACCEPTANCE_CURL_TRACE_DIR="$TRACE_DIR" \
    npm run test:acceptance
)

printf '\nAcceptance traces written to: %s\n' "$TRACE_DIR"
printf 'Inspect with: less %s/*.trace\n' "$TRACE_DIR"
