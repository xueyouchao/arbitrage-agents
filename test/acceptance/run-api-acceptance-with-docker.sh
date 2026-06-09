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

cleanup() {
  local status=$?
  sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required for this acceptance wrapper\n' >&2
  exit 1
}

if ! sudo -n docker ps >/dev/null 2>&1; then
  printf 'passwordless sudo docker access is required; try: sudo docker ps\n' >&2
  exit 1
fi

if ss -ltn "sport = :${DB_PORT}" | grep -q ":${DB_PORT}"; then
  printf 'port %s is already in use; set ACCEPTANCE_POSTGRES_PORT to a free port\n' "$DB_PORT" >&2
  exit 1
fi

rm -rf "$TRACE_DIR"
mkdir -p "$TRACE_DIR"

sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

printf 'Starting disposable Postgres %s on 127.0.0.1:%s/%s...\n' "$POSTGRES_IMAGE" "$DB_PORT" "$DB_NAME"
sudo docker run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:${DB_PORT}:5432" \
  "$POSTGRES_IMAGE" >/dev/null

for attempt in $(seq 1 60); do
  if sudo docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    printf 'Disposable Postgres is ready.\n'
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    printf 'Disposable Postgres did not become ready. Container logs:\n' >&2
    sudo docker logs "$CONTAINER" >&2 || true
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
